import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RESUME_FILE, RecordingSession } from '../src/session.js';
import { LIVE_FILE, liveHeader, liveMark, liveSpeech } from '../src/livenotes.js';

test('a transcribed clip is one paragraph, stamped where its speech starts', () => {
  const entry = {
    offsetMs: 61_000,
    speaker: 'Lilu',
    segments: [
      { start: 1.2, end: 3, text: ' The logo goes ' },
      { start: 3.1, end: 4, text: 'in royal purple.' },
    ],
  };
  assert.equal(liveSpeech(entry), '**[00:01:02] Lilu:** The logo goes in royal purple.\n\n');
  assert.equal(liveSpeech({ offsetMs: 0, speaker: 'Lilu', segments: [{ start: 0, end: 1, text: '  ' }] }), '');
});

test('notes about the recording and the header read as Markdown', () => {
  assert.equal(liveMark(750_000, 'Recording paused by Gig.'), '_[00:12:30] Recording paused by Gig._\n\n');
  const head = liveHeader({ guildName: 'Column & Coin', channelName: 'Office', startedAtMs: 0, startedBy: 'gig' });
  assert.match(head, /^# Live notes: Office \(Column & Coin\), started /);
  assert.match(head, /Recording started by gig\. Times count from this moment\./);
});

function fakeConnection() {
  return { on() {}, destroy() {}, receiver: { speaking: { users: new Map(), on() {} } } };
}

function fakeTranscriber() {
  return {
    ready: true,
    rate: null,
    async transcribe(path) {
      return { segments: [{ start: 0, end: 1, text: `said in ${basename(path)}` }] };
    },
  };
}

const guild = { id: 'g', name: 'Column & Coin', members: { cache: new Map(), fetch: async () => ({ displayName: 'Gig' }) } };
const base = {
  transcriber: fakeTranscriber(),
  voiceChannel: { id: 'v', name: 'Office', guild },
  textChannel: { id: 't' },
  startedBy: { id: 'u', tag: 'gig' },
  connect: async () => fakeConnection(),
};

function cfgIn(extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'scribbydascribe-live-'));
  return { ffmpeg: 'ffmpeg', minClipMs: 400, silenceMs: 800, maxClipMs: 10_000, dataDir, ...extra };
}

const readJson = (dir) => JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));

test('live.md grows as the call goes, and session.json says it is live until the transcript is out', async () => {
  const s = new RecordingSession({ cfg: cfgIn(), ...base });
  await s.start();
  assert.equal(readJson(s.dir).live, true);
  assert.equal(readJson(s.dir).liveNotes, LIVE_FILE);

  s.recordRoll({ channel: { id: 'c', name: 'dice' }, user: { id: 'u', username: 'gig' }, member: { displayName: 'Gig' }, text: 'rolled 17' });
  assert.ok(s.pause('Gig'));
  assert.ok(s.resume());
  await s.settled();
  await s.saveState(); // also waits for live.md to be written

  const during = readFileSync(join(s.dir, LIVE_FILE), 'utf8');
  assert.match(during, /^# Live notes: Office \(Column & Coin\)/);
  assert.match(during, /💬 \*\*\[00:00:00\] Gig in #dice:\*\* rolled 17/);
  assert.match(during, /_\[00:00:00\] Recording paused by Gig\._/);
  assert.match(during, /_\[00:00:00\] Recording resumed\._/);
  assert.ok(during.indexOf('rolled 17') < during.indexOf('paused by Gig'), 'in the order it happened');

  await s.stop('stopped by Gig');
  const after = readFileSync(join(s.dir, LIVE_FILE), 'utf8');
  assert.ok(after.startsWith(during), 'only ever appended to');
  assert.match(after, /Recording stopped \(stopped by Gig\)\._/);
  assert.match(after, /Live notes end here\. transcript\.md has the finished transcript\._\n$/);
  assert.equal(readJson(s.dir).live, false);
});

test('speech lands in live.md as it is transcribed, across a restart', async () => {
  const cfg = cfgIn();
  const before = new RecordingSession({ cfg, ...base });
  await before.start();
  await before.suspend();
  await before.settled();
  await before.saveState();

  const file = join(before.dir, RESUME_FILE);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.clips = [{ speakerId: 'a', offsetMs: 4_000, durationMs: 2_000, file: join('clips', '000004000_a.wav') }];
  state.names = { a: 'Lilu' };
  writeFileSync(file, JSON.stringify(state));

  const s = await RecordingSession.restore({ state: JSON.parse(readFileSync(file, 'utf8')), cfg, ...base });
  s.requeue();
  await s.rejoin();
  await s.settled();
  await s.saveState(); // also waits for live.md to be written

  const md = readFileSync(join(s.dir, LIVE_FILE), 'utf8');
  assert.match(md, /Recording paused while the bot restarts\._/);
  assert.match(md, /Recording resumed after the restart, \d\d:\d\d:\d\d later\._/);
  assert.match(md, /\*\*\[00:00:04\] Lilu:\*\* said in 000004000_a\.wav/);
  assert.equal((md.match(/^# Live notes/gm) ?? []).length, 1, 'one header, not one per restart');
  await s.stop('stopped');
});

test('with live notes off there is no live.md and no live flag', async () => {
  const s = new RecordingSession({ cfg: cfgIn({ liveNotes: false }), ...base });
  await s.start();
  s.recordRoll({ channel: { id: 'c', name: 'dice' }, user: { id: 'u', username: 'gig' }, text: 'rolled 3' });
  await s.stop('stopped');
  assert.equal(existsSync(join(s.dir, LIVE_FILE)), false);
  assert.equal(readJson(s.dir).live, undefined);
});
