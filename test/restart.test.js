import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RESUME_FILE, RecordingSession, Suspended, findSuspended } from '../src/session.js';

const cfg = { ffmpeg: 'ffmpeg', minClipMs: 400, silenceMs: 800, maxClipMs: 30_000 };

function fakeConnection() {
  return { on() {}, destroy() {}, receiver: { speaking: { users: new Map(), on() {} } } };
}

/** A transcriber that says the clip's name, and remembers what it was asked. */
function fakeTranscriber() {
  const asked = [];
  return {
    asked,
    ready: true,
    rate: null,
    async transcribe(path) {
      asked.push(basename(path));
      return { segments: [{ start: 0, end: 1, text: `said in ${basename(path)}` }] };
    },
  };
}

function newSession(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-restart-'));
  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = new RecordingSession({
    cfg,
    transcriber: fakeTranscriber(),
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: { id: 't' },
    startedBy: { id: 'u', tag: 'gig' },
    connect: async () => fakeConnection(),
    ...o,
  });
  s.dir = dir;
  s.startedAt = Date.now() - 60_000;
  s.connection = fakeConnection();
  return s;
}

const clip = (offsetMs, durationMs = 2_000, speakerId = 'a') => ({
  speakerId,
  offsetMs,
  durationMs,
  file: join('clips', `${String(offsetMs).padStart(9, '0')}_${speakerId}.wav`),
});

test('a suspended recording marks the restart as a pause and saves its state', async () => {
  const s = newSession();
  assert.ok(await s.suspend());
  assert.ok(s.pausedAt > 0, 'nothing is captured while the bot is down');
  await s.settled();
  await s.saveState();

  const found = await findSuspended(dirname(s.dir));
  const mine = found.find((f) => f.state.dir === s.dir);
  assert.ok(mine, 'the next start can find it');
  assert.equal(mine.state.stopping, false);
  assert.equal(mine.state.pauses.length, 1);
  assert.equal(mine.state.pauses[0].restart, true);
  assert.equal(mine.state.pauses[0].endMs, null);
  assert.equal(mine.state.textChannelId, 't');
  assert.equal(mine.state.startedById, 'u');
});

test('a restored recording carries on, transcribing only what was left, with the gap marked', async () => {
  const before = newSession();
  await before.suspend();
  await before.saveState();
  const file = join(before.dir, RESUME_FILE);
  const state = JSON.parse(readFileSync(file, 'utf8'));

  // Three clips: one done and on record, one done while the state was being
  // taken (only events.jsonl knows), one never reached.
  const [a, b, c] = [clip(1_000), clip(5_000), clip(9_000, 3_000, 'b')];
  state.clips = [a, b, c];
  state.done = [a.file];
  state.names = { a: 'Gig', b: 'Ferren' };
  writeFileSync(file, JSON.stringify(state));
  const entry = (k) => JSON.stringify({ offsetMs: k.offsetMs, speakerId: k.speakerId, speaker: 'Gig', segments: [{ start: 0, end: 1, text: `said in ${basename(k.file)}` }], file: k.file });
  writeFileSync(join(before.dir, 'events.jsonl'), `${entry(a)}\n${entry(b)}\n{"cut short`);

  const transcriber = fakeTranscriber();
  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = await RecordingSession.restore({
    state: JSON.parse(readFileSync(file, 'utf8')),
    cfg,
    transcriber,
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: { id: 't' },
    startedBy: { id: 'u', tag: 'gig' },
    connect: async () => fakeConnection(),
  });
  assert.equal(existsSync(file), false, 'restored once, not on every start');
  assert.equal(s.snapshot.clips, 3);
  assert.equal(s.snapshot.clipsDone, 2);

  s.requeue();
  await s.rejoin();
  assert.equal(s.pausedAt, 0, 'recording again');
  assert.equal(s.phase, 'recording');

  const res = await s.stop('stopped by Gig');
  assert.deepEqual(transcriber.asked, [basename(c.file)], 'only the clip never reached');
  assert.equal(res.lines.length, 3);
  assert.equal(res.meta.pauses.length, 1);
  assert.ok(res.meta.pauses[0].endMs > res.meta.pauses[0].startMs - 1);
  const md = readFileSync(join(s.dir, 'transcript.md'), 'utf8');
  assert.match(md, /Recording paused while the bot restarted for \d\d:\d\d:\d\d/);
});

test('a recording that cannot resume ends where the restart began', async () => {
  const before = newSession();
  await before.suspend();
  await before.saveState();
  const state = JSON.parse(readFileSync(join(before.dir, RESUME_FILE), 'utf8'));

  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = await RecordingSession.restore({
    state,
    cfg,
    transcriber: fakeTranscriber(),
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: { id: 't' },
    startedBy: { id: 'u', tag: 'gig' },
  });
  s.requeue();
  s.endAtSuspend();
  const res = await s.stop('everyone left while the bot was restarting');
  assert.equal(res.meta.pauses.length, 0, 'no trailing pause');
  assert.equal(res.meta.durationMs, state.suspendedAt - state.startedAt);
});

test('clips cut off by a restart are kept for later, not counted as failed', async () => {
  let reject;
  const hanging = {
    ready: true,
    rate: null,
    transcribe: () => new Promise((_, r) => (reject = r)),
  };
  const s = newSession();
  await s.suspend();
  await s.saveState();
  const state = JSON.parse(readFileSync(join(s.dir, RESUME_FILE), 'utf8'));
  state.clips = [clip(1_000)];
  state.done = [];

  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const r = await RecordingSession.restore({
    state,
    cfg,
    transcriber: hanging,
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: { id: 't' },
    startedBy: { id: 'u', tag: 'gig' },
    connect: async () => fakeConnection(),
  });
  r.requeue();
  await r.rejoin();
  const stopping = r.stop('stopped');
  await new Promise((ok) => setImmediate(ok));
  assert.ok(await r.suspend(), 'a stopped session still transcribing can be suspended');

  reject(new Error('transcription worker exited (SIGTERM)'));
  await r.settled();
  await assert.rejects(stopping, Suspended);
  const saved = r.state;
  assert.equal(saved.failed, 0);
  assert.deepEqual(saved.done, []);
  assert.equal(saved.stopping, true);
  assert.ok(saved.stoppedAt > 0);
});
