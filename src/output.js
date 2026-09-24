// Turns transcribed clips into the finished transcript files, and stitches
// each speaker's clips into one track aligned to the session start.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SAMPLES_PER_MS, wavPayload } from './audio.js';

/**
 * One line per Whisper segment, on the session timeline.
 * @param {Array<{offsetMs:number, speakerId:string, speaker:string, segments:{start:number,end:number,text:string}[]}>} entries
 */
export function buildLines(entries) {
  const lines = [];
  for (const e of entries) {
    for (const s of e.segments) {
      lines.push({
        startMs: Math.round(e.offsetMs + s.start * 1000),
        endMs: Math.round(e.offsetMs + s.end * 1000),
        speakerId: e.speakerId,
        speaker: e.speaker,
        text: s.text,
      });
    }
  }
  return lines.sort((a, b) => a.startMs - b.startMs || a.speaker.localeCompare(b.speaker));
}

/** Consecutive lines by the same speaker, close together, read as one paragraph. */
export function paragraphs(lines, joinGapMs = 2000) {
  const out = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (last && last.speakerId === l.speakerId && l.startMs - last.endMs <= joinGapMs) {
      last.text += ' ' + l.text;
      last.endMs = Math.max(last.endMs, l.endMs);
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

export function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function srtClock(ms) {
  const t = Math.max(0, Math.round(ms));
  return `${clock(t)},${String(t % 1000).padStart(3, '0')}`;
}

export function toMarkdown(meta, lines) {
  const started = new Date(meta.startedAt);
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const head = [
    `# ${meta.guildName} / ${meta.channelName} — ${started.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `- Started: ${started.toISOString()}`,
    `- Duration: ${clock(meta.durationMs)}`,
    `- Speakers: ${speakers.length ? speakers.join(', ') : '(none)'}`,
    `- Timestamps are offsets from the start time above.`,
    '',
    '---',
    '',
  ];
  const body = paragraphs(lines).map((p) => `**[${clock(p.startMs)}] ${p.speaker}:** ${p.text}\n`);
  return head.join('\n') + (body.length ? body.join('\n') : '_Nothing was transcribed._\n');
}

export function toSrt(lines) {
  return lines
    .map((l, i) => `${i + 1}\n${srtClock(l.startMs)} --> ${srtClock(Math.max(l.endMs, l.startMs + 500))}\n${l.speaker}: ${l.text}\n`)
    .join('\n');
}

export function toJson(meta, lines, clips) {
  return JSON.stringify({ ...meta, lines, clips }, null, 2) + '\n';
}

/** Filesystem-safe name for a speaker's track. */
export function safeName(name) {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'speaker';
}

function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => (err ? reject(err) : undefined));
    if (ok) resolve();
    else stream.once('drain', resolve);
  });
}

function runFfmpeg(ffmpeg, args, feed) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'inherit'],
    });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    // EPIPE if ffmpeg dies early; its exit code carries the real error.
    p.stdin?.on('error', () => {});
    if (feed) feed(p.stdin).then(() => p.stdin.end(), (err) => { p.kill(); reject(err); });
  });
}

const SILENCE_CHUNK = Buffer.alloc(48_000 * 2); // one second of mono silence

async function writeSilence(stdin, samples) {
  let left = samples * 2;
  while (left > 0) {
    const n = Math.min(left, SILENCE_CHUNK.length);
    await writeAsync(stdin, SILENCE_CHUNK.subarray(0, n));
    left -= n;
  }
}

/**
 * Writes tracks/<speaker>.ogg for every speaker, each exactly as long as the
 * session and silent wherever that person was, plus tracks/mix.ogg. Any of
 * these drops straight onto a video editor timeline at the session start.
 */
export async function buildTracks({ ffmpeg, sessionDir, clips, speakers, durationMs }) {
  const totalSamples = Math.round(durationMs * SAMPLES_PER_MS);
  const byUser = new Map();
  for (const c of clips) {
    if (!byUser.has(c.speakerId)) byUser.set(c.speakerId, []);
    byUser.get(c.speakerId).push(c);
  }

  const outputs = [];
  const used = new Set();
  for (const [userId, list] of byUser) {
    list.sort((a, b) => a.offsetMs - b.offsetMs);
    let base = safeName(speakers.get(userId) ?? userId);
    while (used.has(base)) base += `_${userId.slice(-4)}`;
    used.add(base);
    const out = join(sessionDir, 'tracks', `${base}.ogg`);

    await runFfmpeg(
      ffmpeg,
      ['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '48k', out],
      async (stdin) => {
        let written = 0;
        for (const c of list) {
          const start = Math.round(c.offsetMs * SAMPLES_PER_MS);
          let pcm = wavPayload(await readFile(join(sessionDir, c.file)));
          if (start > written) {
            await writeSilence(stdin, start - written);
            written = start;
          } else if (start < written) {
            // Overlaps the previous clip; skip the part already written.
            pcm = pcm.subarray(Math.min(pcm.length, (written - start) * 2));
          }
          await writeAsync(stdin, pcm);
          written += pcm.length / 2;
        }
        if (totalSamples > written) await writeSilence(stdin, totalSamples - written);
      },
    );
    outputs.push(out);
  }

  if (outputs.length > 1) {
    const inputs = outputs.flatMap((o) => ['-i', o]);
    await runFfmpeg(ffmpeg, [
      ...inputs,
      '-filter_complex', `amix=inputs=${outputs.length}:normalize=0`,
      '-c:a', 'libopus', '-b:a', '64k',
      join(sessionDir, 'tracks', 'mix.ogg'),
    ]);
  }
  return outputs;
}
