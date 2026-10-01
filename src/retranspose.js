// /scribe transpose, applied after the fact: a recording that already
// finished without party mode (or with a different one declared) can still
// be re-split, once its clips are walked through the same
// embedding -> cluster path a live session takes. Rewrites that session's
// transcript and tracks in place.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonl } from './session.js';
import { SpeakerClusters, rawSpeakerId } from './diarize.js';
import { buildLines, buildTracks, toJson, toMarkdown, toSrt } from './output.js';

/**
 * @param {object} o
 * @param {object} o.cfg
 * @param {import('./transcriber.js').Transcriber} o.transcriber
 * @param {string} o.sessionDir a finished session's folder
 * @param {string} o.userId the Discord account whose clips to re-split
 * @param {string[]} o.names declared party members, in assignment order
 * @returns {Promise<{lines: number, relabeled: number, names: string[]}>}
 */
export async function applyTranspose({ cfg, transcriber, sessionDir, userId, names }) {
  const transcript = JSON.parse(await readFile(join(sessionDir, 'transcript.json'), 'utf8'));
  let session = {};
  try {
    session = JSON.parse(await readFile(join(sessionDir, 'session.json'), 'utf8'));
  } catch {
    /* older or still-writing session; fall back to the raw account name below */
  }

  const clips = transcript.clips ?? [];
  const mine = clips.filter((c) => rawSpeakerId(c.speakerId) === userId).sort((a, b) => a.offsetMs - b.offsetMs);
  if (!mine.length) throw new Error("That account never spoke in this recording.");

  const entries = new Map((await readJsonl(join(sessionDir, 'events.jsonl'))).map((e) => [e.file, e]));
  const displayName = session.speakers?.[userId] ?? entries.get(mine[0].file)?.speaker ?? userId;

  const clusters = new SpeakerClusters(names, [], cfg.voiceSplitThreshold);
  let relabeled = 0;
  for (const clip of mine) {
    let embedding;
    try {
      ({ embedding } = await transcriber.embedOnly(join(sessionDir, clip.file)));
    } catch (err) {
      console.error(`[transpose] could not embed ${clip.file}: ${err.message}`);
    }
    if (!embedding) continue;
    const { name } = clusters.assign(embedding);
    clip.speakerId = `${userId}:${name}`;
    const entry = entries.get(clip.file);
    if (entry) {
      entry.speakerId = clip.speakerId;
      entry.speaker = `${name} (via ${displayName})`;
    }
    relabeled++;
  }

  await writeFile(
    join(sessionDir, 'events.jsonl'),
    [...entries.values()].map((e) => JSON.stringify(e)).join('\n') + (entries.size ? '\n' : ''),
  );

  const lines = buildLines([...entries.values()]);
  const chat = await readJsonl(join(sessionDir, 'chat.jsonl'));
  await writeFile(join(sessionDir, 'transcript.md'), toMarkdown(transcript, lines, chat));
  await writeFile(join(sessionDir, 'transcript.srt'), toSrt(lines));
  await writeFile(join(sessionDir, 'transcript.json'), toJson(transcript, lines, clips, chat));

  const trackSpeakers = new Map(Object.entries(session.speakers ?? {}));
  for (const c of clips) {
    if (!trackSpeakers.has(c.speakerId) && c.speakerId !== rawSpeakerId(c.speakerId)) {
      trackSpeakers.set(c.speakerId, c.speakerId.slice(rawSpeakerId(c.speakerId).length + 1));
    }
  }
  try {
    await buildTracks({ ffmpeg: cfg.ffmpeg, sessionDir, clips, speakers: trackSpeakers, durationMs: transcript.durationMs });
  } catch (err) {
    console.error('[transpose] rebuilding tracks failed:', err);
  }

  return { lines: lines.length, relabeled, names: clusters.clusters.map((c) => c.name) };
}
