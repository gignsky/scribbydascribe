// The words behind /scribe help and /scribe status. Pure functions of a
// session snapshot (RecordingSession#snapshot), so they are easy to test.

import { clock } from './output.js';

export const HELP = [
  '**scrivener** records this server\'s voice calls and writes a transcript labelled by speaker.',
  '',
  '`/scribe start`: join your voice channel and start recording. Everyone in the call is told.',
  '`/scribe pause`: stop capturing audio but stay in the call. Nothing said while paused is saved.',
  '`/scribe resume`: start capturing again after a pause.',
  '`/scribe stop`: end the recording. The transcript is posted here once it is finished.',
  '`/scribe status`: what is being recorded, or how far along a stopped recording\'s transcript is.',
  '`/scribe export`: pick past sessions and get their transcripts combined into one JSONL or CSV file.',
  '`/scribe help`: this message.',
  '',
  'The bot also stops by itself two minutes after everyone has left the call.',
  'After a stop, the transcript is posted as `transcript.md` and `transcript.srt`.',
].join('\n');

/** A text progress bar, e.g. `▓▓▓▓▓▓░░░░ 60%`. */
export function bar(done, total, width = 10) {
  const f = total > 0 ? Math.min(1, Math.max(0, done / total)) : 1;
  const n = Math.round(f * width);
  return `${'▓'.repeat(n)}${'░'.repeat(width - n)} ${Math.floor(f * 100)}%`;
}

/**
 * Time left to transcribe the backlog, from the rate audio has been getting
 * through since the stop. Null until there is enough to go on.
 */
export function etaMs(snap, now) {
  const left = snap.audioMs - snap.audioDoneMs;
  if (left <= 0) return 0;
  if (!snap.drain) return null;
  const elapsed = now - snap.drain.atMs;
  const done = snap.audioDoneMs - snap.drain.audioDoneMs;
  if (elapsed < 5_000 || done <= 0) return null;
  return Math.round((left / done) * elapsed);
}

function roughly(ms) {
  if (ms < 60_000) return 'under a minute';
  const min = Math.round(ms / 60_000);
  return min === 1 ? 'about 1 minute' : `about ${min} minutes`;
}

function soFar(s) {
  return `${s.speakers} speaker(s), ${s.lines} line(s) so far`;
}

/** One session's status line(s). */
export function describe(s, now = Date.now()) {
  const paused = s.pausedMs > 0 ? ` (${clock(s.pausedMs)} of it paused)` : '';
  const backlog = s.clips - s.clipsDone;

  switch (s.phase) {
    case 'recording':
      return (
        `🔴 Recording **${s.channelName}** for ${clock(s.durationMs)}${paused}: ` +
        `${soFar(s)}, ${backlog} clip(s) waiting to transcribe.`
      );
    case 'paused':
      return (
        `⏸️ **${s.channelName}** is paused` +
        (s.pausedBy ? ` by ${s.pausedBy}` : '') +
        ` (for ${clock(s.pausedForMs)}). Nothing is being recorded; \`/scribe resume\` continues. ` +
        `Session ${clock(s.durationMs)}${paused}, ${soFar(s)}.`
      );
    case 'transcribing': {
      const eta = etaMs(s, now);
      return (
        `⏳ Recording of **${s.channelName}** stopped (${s.reason}); finishing the transcript.\n` +
        `Transcribing: ${bar(s.audioDoneMs, s.audioMs)}, ` +
        `${s.clipsDone} of ${s.clips} clip(s) done, ${clock(s.audioMs - s.audioDoneMs)} of audio left` +
        (eta === null ? '.' : `, ${roughly(eta)} to go.`) +
        `\n${s.lines} line(s) transcribed so far.`
      );
    }
    case 'writing':
      return `📝 Recording of **${s.channelName}** stopped (${s.reason}). Transcription done; writing the transcript files.`;
    case 'tracks':
      return `🎚️ Recording of **${s.channelName}** stopped (${s.reason}). Transcript written; building the per-speaker audio tracks.`;
    case 'done':
      return `📤 Recording of **${s.channelName}** is finished; posting the transcript.`;
    default:
      return `**${s.channelName}**: ${s.phase}`;
  }
}
