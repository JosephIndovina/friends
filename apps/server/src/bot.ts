import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, DiscordAPIError, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder,
} from "discord.js";
import type { FastifyBaseLogger } from "fastify";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { events } from "./events.js";
import { deleteUserSessions, isOwner } from "./sessions.js";
import { getSettings } from "./settings.js";

const MEMBERSHIP_CHECK_MS = 15 * 60 * 1000;
const UNKNOWN_MEMBER = 10007;

const commands = [new SlashCommandBuilder().setName("site").setDescription("Get the link to the friends site")];

// View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History
const BOT_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 14n) | (1n << 15n) | (1n << 16n);

export function installUrl() {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    scope: "bot applications.commands",
    permissions: BOT_PERMISSIONS.toString(),
    guild_id: env.DISCORD_GUILD_ID,
    disable_guild_select: "true",
  }).toString();
  return url.toString();
}

export function linkButton(label: string, url: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url));
}

const siteUrl = (path = "/") => new URL(path, env.PUBLIC_URL).toString();

export async function startBot(log: FastifyBaseLogger) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (c) => {
    log.info(`bot ready as ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
      await guild.commands.set(commands.map((cmd) => cmd.toJSON()));
      log.info(`slash commands registered in ${guild.name}`);
    } catch (err) {
      log.warn({ err }, `bot is not in server ${env.DISCORD_GUILD_ID} yet; add it with ${installUrl()}`);
    }
    void checkMembership();
    setInterval(() => void checkMembership(), MEMBERSHIP_CHECK_MS).unref();
  });
  client.on(Events.Error, (err) => log.error({ err }, "discord client error"));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.guildId !== env.DISCORD_GUILD_ID) return;
    if (interaction.commandName === "site") {
      await interaction.reply({ content: "Come hang out.", components: [linkButton("Open friends", siteUrl())], flags: MessageFlags.Ephemeral });
    }
  });

  /** Anyone approved who has left the Discord server loses access (restored automatically if they rejoin and sign in). */
  async function checkMembership() {
    const guild = client.guilds.cache.get(env.DISCORD_GUILD_ID);
    if (!guild) return;
    const users = db.prepare("SELECT id, name FROM users WHERE status IN ('active', 'pending')").all() as Array<{ id: string; name: string }>;
    for (const u of users) {
      if (isOwner(u.id)) continue;
      try {
        await guild.members.fetch({ user: u.id, force: true });
      } catch (err) {
        if (err instanceof DiscordAPIError && err.code === UNKNOWN_MEMBER) {
          db.prepare("UPDATE users SET status = 'left', status_reason = 'Left the Discord server' WHERE id = ?").run(u.id);
          deleteUserSessions(u.id);
          audit({ actorId: null, action: "user.left_server", target: { type: "user", id: u.id, name: u.name } });
          events.emit("user:kick", u.id);
        } else {
          log.warn({ err, user: u.id }, "membership check failed");
        }
      }
    }
  }

  async function notify(opts: { title: string; description?: string; url: string; buttonLabel?: string; thumbnail?: string }) {
    const channelId = getSettings().notify.channelId;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) return;
    const embed = new EmbedBuilder().setTitle(opts.title).setURL(opts.url).setColor(0x6f95d8);
    if (opts.description) embed.setDescription(opts.description);
    if (opts.thumbnail) embed.setThumbnail(opts.thumbnail);
    await channel.send({ embeds: [embed], components: [linkButton(opts.buttonLabel ?? "Join", opts.url)] });
  }

  events.on("access:requested", (user) => {
    if (!getSettings().notify.accessRequests) return;
    notify({
      title: `${user.name} asked to join friends`,
      description: "An admin can approve or deny them in the admin panel.",
      url: siteUrl("/admin"),
      buttonLabel: "Review",
      thumbnail: user.avatarUrl,
    }).catch((err) => log.warn({ err }, "access request notification failed"));
  });

  await client.login(env.DISCORD_BOT_TOKEN);
  return { client, notify };
}
