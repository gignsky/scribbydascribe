// The words behind /scribe help and /scribe status. Pure functions of a
// session snapshot (RecordingSession#snapshot), so they are easy to test.

import { clock } from './output.js';

export const HELP = [
  '**scrivener** records this server\'s voice calls and writes a transcript labelled by speaker.',
  '',
  '`/scribe start`: join your voice channel and start recording, along with messages posted in this server\'s text channels. Everyone in the call is told.',
  '`/scribe pause`: stop capturing but stay in the call. Nothing said or posted while paused is saved.',
  '`/scribe resume`: start capturing again after a pause.',
  '`/scribe stop`: end the recording. A progress message keeps count of the transcription backlog until the transcript is posted here.',
  '`/scribe status`: what is being recorded and whether transcription is keeping up, or how far along a stopped recording\'s transcript is, with a rough time left.',
  '`/scribe export`: pick past sessions and get their transcripts combined into one JSONL or CSV file.',
  '`/scribe help`: this message.',
  '`/roll [dice] [for]`: roll dice, like `d20`, `2d6+3`, `4d6kh3` (keep the highest 3) or `2d20kh1+5` (advantage). A roll made during a recording goes into its transcript.',
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
 * Time left to transcribe the backlog. After a stop, from the rate audio has
 * been getting through since; before that, or until the stop has given enough
 * to go on, from the worker's measured speed (`rate`, audio ms per ms). Null
 * when there is nothing to go on yet.
 */
export function etaMs(snap, now) {
  const left = snap.audioMs - snap.audioDoneMs;
  if (left <= 0) return 0;
  if (snap.modelLoading) return null;
  if (snap.drain) {
    const elapsed = now - snap.drain.atMs;
    const done = snap.audioDoneMs - snap.drain.audioDoneMs;
    if (elapsed >= 5_000 && done > 0) return Math.round((left / done) * elapsed);
  }
  return snap.rate > 0 ? Math.round(left / snap.rate) : null;
}

function roughly(ms) {
  if (ms < 60_000) return 'under a minute';
  const min = Math.round(ms / 60_000);
  return min === 1 ? 'about 1 minute' : `about ${min} minutes`;
}

const LOADING = '\n⌛ The speech model is still loading; transcription starts once it is ready.';

/** While recording: how far transcription lags behind the call, if at all. */
function backlog(s, now) {
  const clips = s.clips - s.clipsDone;
  const left = s.audioMs - s.audioDoneMs;
  if (clips <= 0) return 'transcription is keeping up.';
  const eta = etaMs(s, now);
  return (
    `${clips} clip(s) waiting to transcribe` +
    (left > 0 ? ` (${clock(left)} of audio${eta ? `, ${roughly(eta)} to catch up` : ''})` : '') +
    '.'
  );
}

function soFar(s) {
  return `${s.speakers} speaker(s), ${s.lines} line(s)` + (s.chat ? `, ${s.chat} chat message(s)` : '') + ' so far';
}

/** One session's status line(s). */
export function describe(s, now = Date.now()) {
  const paused = s.pausedMs > 0 ? ` (${clock(s.pausedMs)} of it paused)` : '';
  const loading = s.modelLoading ? LOADING : '';

  switch (s.phase) {
    case 'recording':
      return (
        `🔴 Recording **${s.channelName}** for ${clock(s.durationMs)}${paused}: ` +
        `${soFar(s)}; ${backlog(s, now)}` +
        loading
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
        `\n${s.lines} line(s) transcribed so far.` +
        loading
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

/**
 * The line a stopped recording's progress message ends on once its
 * transcript is out.
 * @param {{ channelName: string, lines: number, failed?: number, posted: boolean }} r
 */
export function finishedLine(r) {
  return r.posted
    ? `✅ Transcript of **${r.channelName}** finished and posted: ${r.lines} line(s)` +
        (r.failed ? `, ${r.failed} clip(s) failed` : '') +
        '.'
    : `⚠️ Transcript of **${r.channelName}** finished (${r.lines} line(s)), but it could not be posted. It is saved on the host.`;
}

/**
 * `/scribe status` when nothing is recording or finishing: when the last
 * recording ended, so "Not recording" is not mistaken for "lost".
 * @param {{ channelName: string, finishedAt: number, lines: number, posted: boolean, postedIn?: string } | undefined} last
 */
export function describeLast(last) {
  if (!last) return 'Not recording.';
  const when = `<t:${Math.floor(last.finishedAt / 1000)}:R>`;
  return (
    `Not recording. The last recording, of **${last.channelName}**, finished ${when} with ${last.lines} line(s)` +
    (last.posted ? `; its transcript was posted${last.postedIn ? ` in ${last.postedIn}` : ''}.` : ', but its transcript could not be posted. It is saved on the host.')
  );
}
