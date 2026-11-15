import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { FastifyBaseLogger } from "fastify";
import { env } from "./env.js";

const prodUrl = env.PUBLIC_URL;

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

export async function startBot(log: FastifyBaseLogger) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  client.once(Events.ClientReady, async (c) => {
    log.info(`bot ready as ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
      await guild.commands.set(commands.map((cmd) => cmd.toJSON()));
      log.info(`slash commands registered in ${guild.name}`);
    } catch (err) {
      log.warn({ err }, `bot is not in server ${env.DISCORD_GUILD_ID} yet; add it with ${installUrl()}`);
    }
  });
  client.on(Events.Error, (err) => log.error({ err }, "discord client error"));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.guildId !== env.DISCORD_GUILD_ID) return;
    if (interaction.commandName === "site") {
      await interaction.reply({ content: "Come hang out.", components: [linkButton("Open friends", prodUrl)], flags: MessageFlags.Ephemeral });
    }
  });

  await client.login(env.DISCORD_BOT_TOKEN);

  /** Post an embed with a Join button to the notification channel. Later phases batch these. */
  async function notify(opts: { title: string; description?: string; url: string; buttonLabel?: string; thumbnail?: string }) {
    if (!env.DISCORD_NOTIFY_CHANNEL_ID) return;
    const channel = await client.channels.fetch(env.DISCORD_NOTIFY_CHANNEL_ID);
    if (!channel?.isSendable()) return;
    const embed = new EmbedBuilder().setTitle(opts.title).setURL(opts.url).setColor(0xc9a27a);
    if (opts.description) embed.setDescription(opts.description);
    if (opts.thumbnail) embed.setThumbnail(opts.thumbnail);
    await channel.send({ embeds: [embed], components: [linkButton(opts.buttonLabel ?? "Join", opts.url)] });
  }

  return { client, notify };
}
