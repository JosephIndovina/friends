import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, DiscordAPIError, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder,
} from "discord.js";
import type { FastifyBaseLogger } from "fastify";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { events } from "./events.js";
import { deleteUserSessions, getUser, isOwner, sessionFor } from "./sessions.js";
import { gate } from "./access.js";
import { mediaRoom } from "./media.js";
import { getPost } from "./posts.js";
import { search, YouTubeError } from "./youtube.js";
import { getSettings } from "./settings.js";

const MEMBERSHIP_CHECK_MS = 15 * 60 * 1000;
const UNKNOWN_MEMBER = 10007;

const commands = [
  new SlashCommandBuilder().setName("site").setDescription("Link to the friends site"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Add something to the player queue")
    .addStringOption((o) => o.setName("what").setDescription("Search words, or a YouTube / Spotify / Twitch link").setRequired(true).setMaxLength(300))
    .addBooleanOption((o) => o.setName("next").setDescription("Play it next instead of at the end")),
  new SlashCommandBuilder().setName("queue").setDescription("What's playing and what's up next"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip what's playing"),
];

const COMMAND_ERRORS: Record<string, string> = {
  unauthenticated: "Sign in at the site first, then try again.",
  pending: "Your access request is still waiting for an admin.",
  inactive: "Your access is suspended.",
  lockdown: "The site is currently limited to admins.",
  missing_permission: "You don't have permission to do that.",
  section_disabled: "The player is turned off.",
  nothing_playing: "Nothing is playing.",
  unsupported_link: "That link isn't supported.",
  video_unavailable: "That video is private, removed, or can't be embedded.",
  queue_full: "The queue is full.",
  no_match: "Couldn't find that track on YouTube.",
  youtube_quota: "The daily YouTube search limit has been reached. Paste a link instead.",
  no_results: "No results.",
};

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
    const name = interaction.commandName;
    if (name === "site") {
      await interaction.reply({ content: "Open the site:", components: [linkButton("Open friends", siteUrl())], flags: MessageFlags.Ephemeral });
      return;
    }
    // Same Discord account = same site account: site permissions apply to commands too.
    const row = getUser(interaction.user.id);
    const session = row ? sessionFor(row) : null;
    const blocked = gate(session);
    const reply = (content: string, ephemeral = true) =>
      interaction.deferred || interaction.replied
        ? interaction.editReply({ content })
        : interaction.reply({ content, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
    if (blocked) return void (await reply(COMMAND_ERRORS[blocked] ?? COMMAND_ERRORS.missing_permission!));
    const s = session!;
    try {
      if (!getSettings().sections.player) throw new Error("section_disabled");
      if (name === "queue") {
        const st = mediaRoom().snapshot();
        if (!st.now) return void (await reply("Nothing is playing."));
        const lines = [`**Now:** ${st.now.item.title}${st.now.playing ? "" : " (paused)"}`, ...st.queue.slice(0, 5).map((q, i) => `${i + 1}. ${q.title}`)];
        if (st.queue.length > 5) lines.push(`…and ${st.queue.length - 5} more`);
        return void (await interaction.reply({ content: lines.join("\n"), components: [linkButton("Open player", siteUrl())], flags: MessageFlags.Ephemeral }));
      }
      if (name === "skip") {
        if (!s.permissions.includes("player.control")) throw new Error("missing_permission");
        await mediaRoom().skip(s);
        const now = mediaRoom().snapshot().now;
        return void (await reply(now ? `Skipped. Now playing: ${now.item.title}` : "Skipped. The queue is empty.", false));
      }
      if (name === "play") {
        if (!s.permissions.includes("player.queue")) throw new Error("missing_permission");
        const what = interaction.options.getString("what", true).trim();
        const next = interaction.options.getBoolean("next") ?? false;
        if (next && !s.permissions.includes("player.control")) throw new Error("missing_permission");
        await interaction.deferReply();
        let url = what;
        if (!/^(https?:\/\/|spotify:)/i.test(what) && !/^(www\.)?(youtube\.com|youtu\.be|twitch\.tv|open\.spotify\.com)\//i.test(what)) {
          const hit = (await search(what)).results[0];
          if (!hit) throw new Error("no_results");
          url = `https://youtu.be/${hit.id}`;
        }
        const before = mediaRoom().snapshot();
        await mediaRoom().add(s, { url, playNext: next });
        const after = mediaRoom().snapshot();
        const added = after.now?.item.addedAt && after.now.item.id !== before.now?.item.id ? after.now.item : (next ? after.queue[0] : after.queue.at(-1));
        const where = after.now?.item.id === added?.id ? "Now playing" : next ? "Playing next" : `Queued (#${after.queue.length})`;
        await interaction.editReply({ content: `${where}: **${added?.title ?? "it"}**`, components: [linkButton("Open player", siteUrl())] });
        return;
      }
    } catch (err) {
      const code = err instanceof YouTubeError ? err.message : (err as Error).message;
      log.info({ code, command: name, user: interaction.user.id }, "command refused");
      await reply(COMMAND_ERRORS[code] ?? "Something went wrong. Try again on the site.").catch(() => {});
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

  events.on("notify", (n) => {
    notify({ ...n, url: siteUrl(n.url) }).catch((err) => log.warn({ err }, "notification failed"));
  });

  // New posts are batched: one message per 10 minutes, listing who posted.
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  events.on("post:created", (id) => {
    if (!getSettings().notify.posts) return;
    pending.push(id);
    timer ??= setTimeout(() => {
      const ids = pending;
      pending = [];
      timer = null;
      const posts = ids.map((i) => getPost(i, "")).filter((p) => p !== null);
      if (!posts.length) return;
      const names = [...new Set(posts.map((p) => p.author.name))];
      const first = posts[0]!;
      notify({
        title: posts.length === 1 ? `New post from ${first.author.name}` : `${posts.length} new posts`,
        description: posts.length === 1 ? first.text.slice(0, 300) || "Shared an attachment." : `From ${names.join(", ")}.`,
        url: siteUrl("/"),
        buttonLabel: "View",
      }).catch((err) => log.warn({ err }, "post digest failed"));
    }, 10 * 60 * 1000);
  });

  events.on("access:requested", (user) => {
    if (!getSettings().notify.accessRequests) return;
    notify({
      title: `Access request: ${user.name}`,
      description: "Approve or deny in the admin panel.",
      url: siteUrl("/admin"),
      buttonLabel: "Review",
      thumbnail: user.avatarUrl,
    }).catch((err) => log.warn({ err }, "access request notification failed"));
  });

  await client.login(env.DISCORD_BOT_TOKEN);
  return { client, notify };
}
