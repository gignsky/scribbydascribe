import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELP, bar, describe, etaMs } from '../src/status.js';
import { buildLines, toMarkdown } from '../src/output.js';
import { RecordingSession } from '../src/session.js';

const base = {
  channelName: 'Council',
  durationMs: 600_000,
  pausedMs: 0,
  pausedBy: null,
  pausedForMs: 0,
  reason: null,
  speakers: 3,
  lines: 40,
  clips: 50,
  clipsDone: 48,
  audioMs: 300_000,
  audioDoneMs: 290_000,
  drain: null,
};

test('help lists every subcommand', () => {
  for (const sub of ['start', 'pause', 'resume', 'stop', 'status', 'export', 'help']) assert.match(HELP, new RegExp(`/scribe ${sub}`));
});

test('bar fills in proportion and clamps', () => {
  assert.equal(bar(6, 10), '▓▓▓▓▓▓░░░░ 60%');
  assert.equal(bar(0, 0), '▓▓▓▓▓▓▓▓▓▓ 100%');
  assert.equal(bar(12, 10), '▓▓▓▓▓▓▓▓▓▓ 100%');
});

test('etaMs waits for evidence, then extrapolates the drain rate', () => {
  const s = { ...base, audioMs: 120_000, audioDoneMs: 30_000, drain: { atMs: 0, audioDoneMs: 0 } };
  assert.equal(etaMs({ ...s, drain: null }, 10_000), null);
  assert.equal(etaMs(s, 2_000), null, 'too soon to tell');
  // 30 s of audio in 10 s: 90 s left takes 30 s more.
  assert.equal(etaMs(s, 10_000), 30_000);
  assert.equal(etaMs({ ...s, audioDoneMs: 120_000 }, 10_000), 0);
});

test('status reads right in every phase', () => {
  assert.match(describe({ ...base, phase: 'recording' }), /Recording \*\*Council\*\* for 00:10:00: 3 speaker\(s\), 40 line\(s\) so far, 2 clip\(s\) waiting/);
  assert.match(describe({ ...base, phase: 'recording', pausedMs: 65_000 }), /\(00:01:05 of it paused\)/);
  assert.match(describe({ ...base, phase: 'paused', pausedBy: 'Gig', pausedForMs: 30_000 }), /paused by Gig \(for 00:00:30\).*\/scribe resume/);

  const t = describe(
    { ...base, phase: 'transcribing', reason: 'stopped by Gig', clipsDone: 30, audioDoneMs: 150_000, drain: { atMs: 0, audioDoneMs: 50_000 } },
    50_000,
  );
  assert.match(t, /stopped \(stopped by Gig\)/);
  assert.match(t, /▓▓▓▓▓░░░░░ 50%, 30 of 50 clip\(s\) done, 00:02:30 of audio left, about 1 minute to go\./);

  assert.match(describe({ ...base, phase: 'writing', reason: 'x' }), /writing the transcript files/);
  assert.match(describe({ ...base, phase: 'tracks', reason: 'x' }), /building the per-speaker audio tracks/);
  assert.match(describe({ ...base, phase: 'done' }), /posting the transcript/);
});

test('markdown marks pauses in the flow of the transcript', () => {
  const lines = buildLines([
    { offsetMs: 1000, speakerId: 'a', speaker: 'Gig', segments: [{ start: 0, end: 1, text: 'Before.' }] },
    { offsetMs: 90_000, speakerId: 'a', speaker: 'Gig', segments: [{ start: 0, end: 1, text: 'After.' }] },
  ]);
  const md = toMarkdown(
    { guildName: 'Realm', channelName: 'Council', startedAt: '2026-09-24T20:00:00.000Z', durationMs: 100_000, pausedMs: 60_000, pauses: [{ startMs: 10_000, endMs: 70_000, by: 'Ferren' }] },
    lines,
  );
  assert.match(md, /- Paused: 1 time\(s\), 00:01:00 in total/);
  assert.match(md, /Before\.\n\n_\[00:00:10\] Recording paused by Ferren for 00:01:00\._\n\n\*\*\[00:01:30\] Gig:\*\* After\./);
  assert.doesNotMatch(toMarkdown({ guildName: 'R', channelName: 'C', startedAt: '2026-09-24T20:00:00.000Z', durationMs: 1 }, lines), /Paused/);
});

test('a session pauses, resumes and reports each finishing phase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-session-'));
  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = new RecordingSession({
    cfg: { ffmpeg: 'ffmpeg', minClipMs: 400, silenceMs: 800, maxClipMs: 30_000 },
    transcriber: {},
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: {},
    startedBy: { tag: 'gig' },
  });
  // What start() would have set up, minus Discord.
  s.dir = dir;
  s.startedAt = Date.now() - 10_000;
  s.connection = { receiver: { speaking: { users: new Map() } }, destroy() {} };

  assert.equal(s.phase, 'recording');
  assert.ok(s.pause('Gig'));
  assert.equal(s.pause('Gig'), false, 'already paused');
  assert.equal(s.phase, 'paused');
  assert.equal(s.snapshot.pausedBy, 'Gig');
  assert.ok(s.resume());
  assert.equal(s.resume(), false, 'not paused');
  assert.ok(s.pause('Ferren'), 'can pause again');

  const phases = new Set();
  const stopped = s.stop('stopped by Gig');
  const watch = setInterval(() => phases.add(s.phase), 1);
  const res = await stopped;
  clearInterval(watch);
  phases.add(s.phase);

  assert.ok(phases.has('done'));
  assert.equal(s.stop(), stopped, 'stop is idempotent');
  assert.equal(s.snapshot.reason, 'stopped by Gig');
  assert.equal(res.meta.pauses.length, 2);
  assert.equal(res.meta.pauses[0].by, 'Gig');
  assert.ok(res.meta.pauses.every((p) => p.endMs >= p.startMs), 'a pause open at stop is closed');
  const meta = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  assert.equal(meta.pauses.length, 2);
  assert.equal(meta.reason, 'stopped by Gig');
  assert.match(readFileSync(join(dir, 'transcript.md'), 'utf8'), /- Paused: 2 time\(s\)/);
});
