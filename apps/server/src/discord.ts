import { ChannelType, type Client } from "discord.js";
import type { DiscordChannel } from "@friends/shared";
import { env } from "./env.js";

/** The bot's client once it has logged in, for admin routes that ask Discord things directly. */
let client: Client | null = null;
export const setDiscordClient = (c: Client) => void (client = c);
/** Gateway heartbeat round trip in ms, or null before the bot has connected. */
export const discordPing = () => (client?.isReady() && client.ws.ping >= 0 ? client.ws.ping : null);

export class DiscordUnavailable extends Error {}

function guild() {
  const g = client?.isReady() ? client.guilds.cache.get(env.DISCORD_GUILD_ID) : undefined;
  if (!g) throw new DiscordUnavailable("bot_offline");
  return g;
}

/** Text and announcement channels the bot can post in, in Discord's sidebar order. */
export async function listTextChannels(): Promise<DiscordChannel[]> {
  const g = guild();
  const all = await g.channels.fetch();
  const me = g.members.me ?? (await g.members.fetchMe());
  const rows: Array<DiscordChannel & { sort: [number, number] }> = [];
  for (const ch of all.values()) {
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) continue;
    const perms = ch.permissionsFor(me);
    if (!perms?.has(["ViewChannel", "SendMessages", "EmbedLinks"])) continue;
    rows.push({ id: ch.id, name: ch.name, category: ch.parent?.name ?? null, sort: [ch.parent?.rawPosition ?? -1, ch.rawPosition] });
  }
  rows.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1]);
  return rows.map(({ sort: _s, ...c }) => c);
}

export async function channelExists(id: string) {
  const ch = await guild().channels.fetch(id).catch(() => null);
  return Boolean(ch?.isSendable());
}
