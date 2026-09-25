// Which gateway intents the bot asks Discord for, and how it copes when one
// of them is refused.
//
// Recording text chat needs Message Content, which Discord treats as
// privileged. Ask for it without the portal toggle switched on and the
// gateway accepts the socket, then closes it with 4014 the moment we
// identify. @discordjs/ws turns that close into an `error` event carrying a
// plain `new Error('Used disallowed intents')`, and by the time it has been
// re-emitted up the shard -> manager -> client chain there is nothing left
// holding it: it escapes as an uncaught exception, out of a websocket close
// handler rather than out of the promise `login()` returned. A try/catch
// around `login()` cannot see it, so the process dies on startup.
//
// The cure is to stop asking for intents we are not allowed. The application
// itself knows: `GET /applications/@me` reports the Message Content grant in
// its flags, and that answer costs one REST call before the gateway is ever
// opened. `isDisallowedIntents` remains for the cases the probe cannot
// settle, so a refusal still degrades to voice-only rather than a crash loop.

import {
  ApplicationFlags,
  ApplicationFlagsBitField,
  GatewayCloseCodes,
  GatewayIntentBits,
  REST,
  Routes,
} from 'discord.js';

// Either flag means the toggle is on. Discord grants the plain one to bots
// approved for Message Content and the "limited" one to bots small enough
// (under 100 servers) not to need approval yet, so both count as a yes.
const CHAT_FLAGS = [ApplicationFlags.GatewayMessageContent, ApplicationFlags.GatewayMessageContentLimited];

/** Needed whatever happens: the guild list, and who is sitting in voice. */
export const VOICE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];

/** The extras that reading the server's text chat needs. */
export const CHAT_INTENTS = [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];

export function intentsFor(recordChat) {
  return recordChat ? [...VOICE_INTENTS, ...CHAT_INTENTS] : [...VOICE_INTENTS];
}

/**
 * Read an application's `flags` as a verdict on Message Content.
 *
 * Returns `null` when the field is absent or unreadable. Not knowing is not
 * the same as being refused: callers may only switch chat recording off on a
 * definite `false`, or a passing REST hiccup would quietly cost a correctly
 * configured bot its chat transcripts.
 */
export function chatIntentAllowed(flags) {
  if (flags === undefined || flags === null) return null;
  try {
    return new ApplicationFlagsBitField(flags).any(CHAT_FLAGS);
  } catch {
    return null;
  }
}

/**
 * Ask Discord what this token's application is allowed, before connecting.
 * Same three-way answer as `chatIntentAllowed`; a failed call is `null`, and
 * the gateway gets to decide after all.
 */
export async function probeChatIntent(token, { rest } = {}) {
  try {
    const api = rest ?? new REST().setToken(token);
    const app = await api.get(Routes.currentApplication());
    return chatIntentAllowed(app?.flags);
  } catch {
    return null;
  }
}

/**
 * Does this look like Discord refusing an intent? The same refusal arrives
 * as a close event (`{ code: 4014 }`), as the bare Error @discordjs/ws throws
 * on that close, and as the `{ error }` envelope it wraps the Error in.
 */
export function isDisallowedIntents(err) {
  const e = err?.error ?? err;
  if (e?.code === GatewayCloseCodes.DisallowedIntents || e?.code === 'DisallowedIntents') return true;
  return /disallowed intents/i.test(e?.message ?? '');
}
