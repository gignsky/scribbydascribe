// Live notes: `live.md` in a session folder, a transcript that grows while
// the call is still going, in scribby-live's format, so something outside the
// bot (Ready Room, `tail -f`, Claude) can read along. Like scribby-live's
// file it is append-only: one complete paragraph per write, never rewritten,
// so a reader never sees half a line.
//
// Clips are transcribed as they finish, not in the order they were spoken, so
// a line can land a few seconds out of sequence. Every line carries its own
// stamp; a reader that needs strict order sorts on it (or reads
// events.jsonl/chat.jsonl, which hold the same lines as data).

import { formatLine } from './live.js';
import { chatLine, clock } from './output.js';

export const LIVE_FILE = 'live.md';

/** The opening of a session's live notes. */
export function liveHeader({ guildName, channelName, startedAtMs, startedBy }) {
  const when = new Date(startedAtMs).toString();
  return (
    `# Live notes: ${channelName} (${guildName}), started ${when}\n\n` +
    `_Recording started by ${startedBy}. Times count from this moment. ` +
    `Lines appear as they are transcribed, so a few may land slightly out of order; each carries its own time._\n\n`
  );
}

/** One transcribed clip as one paragraph: `**[00:01:12] Gig:** text`. */
export function liveSpeech({ offsetMs, speaker, segments }) {
  const text = segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
  if (!text) return '';
  const at = offsetMs + Math.round((segments[0]?.start ?? 0) * 1000);
  return formatLine(at, speaker, text, 'md');
}

/** A chat message, as transcript.md shows it, as its own paragraph. */
export function liveChat(m) {
  return chatLine(m) + '\n';
}

/** A note about the recording itself: `_[00:12:30] Recording paused by Gig._` */
export function liveMark(atMs, text) {
  return `_[${clock(atMs)}] ${text}_\n\n`;
}
