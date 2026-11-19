import type { MediaKind } from "@friends/shared";

/** A phone or tablet: no hover, a finger for a pointer. */
export const touchOnly = typeof matchMedia !== "undefined" && matchMedia("(hover: none) and (pointer: coarse)").matches;

/**
 * Twitch on a touch device uses its own player controls instead of ours. Mobile browsers only let sound start from a tap
 * inside the frame that plays it, so our unmute (a message sent into Twitch's frame) can never turn its sound on there.
 */
export const nativeControls = (kind: MediaKind) => touchOnly && kind.startsWith("twitch");
