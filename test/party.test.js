// /scribe transpose: splitting a shared mic by voice, both live (declared
// before anyone speaks) and retroactively (applied to a finished recording).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RecordingSession } from '../src/session.js';
import { applyTranspose } from '../src/retranspose.js';
import { setMembers } from '../src/transpose.js';
import { toWav, SAMPLES_PER_MS } from '../src/audio.js';
import { buildLines, toJson } from '../src/output.js';

function fakeConnection() {
  return { on() {}, destroy() {}, receiver: { speaking: { users: new Map(), on() {} } } };
}

const tone = (ms) => Buffer.alloc(Math.max(1, ms) * SAMPLES_PER_MS * 2);

/** A transcriber whose embedding for a clip is whichever hint its path contains. */
function fakeTranscriber(byHint) {
  const embeddingFor = (path) => byHint[Object.keys(byHint).find((h) => path.includes(h))];
  return {
    ready: true,
    rate: null,
    async transcribe(path, durationMs, opts = {}) {
      const result = { segments: [{ start: 0, end: 1, text: `said in ${basename(path)}` }] };
      if (opts.embed) {
        const embedding = embeddingFor(path);
        if (embedding) result.embedding = embedding;
      }
      return result;
    },
    async embedOnly(path) {
      const embedding = embeddingFor(path);
      if (!embedding) throw new Error(`no fake embedding for ${path}`);
      return { embedding };
    },
  };
}

test('declared before anyone speaks, a shared mic is split live by voice', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'scribbydascribe-party-roster-'));
  await setMembers(dataDir, 'g', 'shared', ['Alice', 'Bob']);
  const cfg = { ffmpeg: 'ffmpeg', minClipMs: 400, silenceMs: 800, maxClipMs: 30_000, dataDir, voiceSplitThreshold: 0.5 };
  const transcriber = fakeTranscriber({ voice1: [1, 0, 0], voice2: [0, 1, 0] });

  const dir = mkdtempSync(join(tmpdir(), 'scribbydascribe-party-session-'));
  mkdirSync(join(dir, 'clips'), { recursive: true });
  mkdirSync(join(dir, 'tracks'), { recursive: true });
  const clip = (offsetMs, hint) => {
    const file = join('clips', `${String(offsetMs).padStart(9, '0')}_shared_${hint}.wav`);
    writeFileSync(join(dir, file), toWav(tone(2000)));
    return { speakerId: 'shared', offsetMs, durationMs: 2000, file };
  };

  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = await RecordingSession.restore({
    state: {
      version: 1, guildId: 'g', voiceChannelId: 'v', textChannelId: 't',
      startedById: 'u', startedByTag: 'gm', dir,
      startedAt: Date.now() - 10_000, stoppedAt: 0, stopping: false, reason: null,
      suspendedAt: Date.now(), pausedAt: 0, pauses: [],
      names: { shared: 'GM' }, diarization: {},
      clips: [clip(1000, 'voice1'), clip(5000, 'voice2'), clip(9000, 'voice1')],
      done: [], failed: 0,
    },
    cfg, transcriber,
    voiceChannel: { id: 'v', name: 'Table', guild },
    textChannel: { id: 't' },
    startedBy: { id: 'u', tag: 'gm' },
    connect: async () => fakeConnection(),
  });
  s.requeue();
  const res = await s.stop('test done');

  assert.equal(res.lines.length, 3);
  const bySpeaker = Object.fromEntries(res.lines.map((l) => [l.startMs, l.speaker]));
  assert.equal(bySpeaker[1000], 'Alice (via GM)');
  assert.equal(bySpeaker[5000], 'Bob (via GM)');
  assert.equal(bySpeaker[9000], 'Alice (via GM)', 'the third clip is the same voice as the first');

  const md = readFileSync(join(dir, 'transcript.md'), 'utf8');
  assert.match(md, /Alice \(via GM\)/);
  assert.match(md, /Bob \(via GM\)/);
  assert.equal(res.tracksError, null);
  assert.ok(existsSync(join(dir, 'tracks', 'Alice.ogg')));
  assert.ok(existsSync(join(dir, 'tracks', 'Bob.ogg')));
});

function finishedSession({ names, clips, speakerName }) {
  const dir = mkdtempSync(join(tmpdir(), 'scribbydascribe-party-past-'));
  mkdirSync(join(dir, 'clips'), { recursive: true });
  mkdirSync(join(dir, 'tracks'), { recursive: true });
  for (const c of clips) writeFileSync(join(dir, c.file), toWav(tone(c.durationMs)));

  const meta = { guildId: 'g', guildName: 'Realm', channelId: 'v', channelName: 'Table', startedAt: new Date(0).toISOString(), startedAtMs: 0, durationMs: 12_000, pausedMs: 0, pauses: [] };
  const entries = clips.map((c) => ({ offsetMs: c.offsetMs, speakerId: c.speakerId, speaker: speakerName, segments: [{ start: 0, end: 1, text: `said in ${basename(c.file)}` }], file: c.file }));
  writeFileSync(join(dir, 'events.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'chat.jsonl'), '');
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ ...meta, speakers: { shared: speakerName } }));
  writeFileSync(join(dir, 'transcript.json'), toJson(meta, buildLines(entries), clips, []));
  writeFileSync(join(dir, 'transcript.md'), '(stale)');
  return dir;
}

test('a finished recording can be split retroactively, even if it never used party mode', async () => {
  const clips = [
    { speakerId: 'shared', offsetMs: 1000, durationMs: 2000, file: 'clips/voice1_a.wav' },
    { speakerId: 'shared', offsetMs: 5000, durationMs: 2000, file: 'clips/voice2_a.wav' },
    { speakerId: 'shared', offsetMs: 9000, durationMs: 2000, file: 'clips/voice1_b.wav' },
  ];
  const dir = finishedSession({ clips, speakerName: 'GM' });
  const cfg = { ffmpeg: 'ffmpeg', voiceSplitThreshold: 0.5 };
  const transcriber = fakeTranscriber({ voice1: [1, 0, 0], voice2: [0, 1, 0] });

  const res = await applyTranspose({ cfg, transcriber, sessionDir: dir, userId: 'shared', names: ['Alice', 'Bob'] });
  assert.equal(res.relabeled, 3);
  assert.deepEqual(res.names, ['Alice', 'Bob']);
  assert.equal(res.lines, 3);

  const md = readFileSync(join(dir, 'transcript.md'), 'utf8');
  assert.match(md, /Alice \(via GM\)/);
  assert.match(md, /Bob \(via GM\)/);
  assert.ok(!md.includes('(stale)'));

  const transcript = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8'));
  assert.deepEqual(transcript.clips.map((c) => c.speakerId), ['shared:Alice', 'shared:Bob', 'shared:Alice']);
  assert.ok(existsSync(join(dir, 'tracks', 'Alice.ogg')));
  assert.ok(existsSync(join(dir, 'tracks', 'Bob.ogg')));
});

test('applying transpose to an account that never spoke in that session is refused', async () => {
  const clips = [{ speakerId: 'someone-else', offsetMs: 0, durationMs: 1000, file: 'clips/a.wav' }];
  const dir = finishedSession({ clips, speakerName: 'GM' });
  const cfg = { ffmpeg: 'ffmpeg' };
  await assert.rejects(
    applyTranspose({ cfg, transcriber: fakeTranscriber({}), sessionDir: dir, userId: 'shared', names: ['Alice', 'Bob'] }),
    /never spoke/,
  );
});
