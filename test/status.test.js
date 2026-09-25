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

function fakeMessage({ id, at, channelId = 't1', channel = 'general', author = 'Ferren', authorId = 'b', text = '', files = [], bot = false }) {
  return {
    id,
    createdTimestamp: at,
    channelId,
    channel: { name: channel },
    author: { id: authorId, bot, displayName: author, username: author.toLowerCase() },
    member: { displayName: author },
    cleanContent: text,
    attachments: new Map(files.map((f, n) => [String(n), f])),
  };
}

test('a session keeps chat posted while recording, not before, while paused or after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-chat-'));
  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = new RecordingSession({
    cfg: { ffmpeg: 'ffmpeg', minClipMs: 400, silenceMs: 800, maxClipMs: 30_000 },
    transcriber: {},
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: {},
    startedBy: { tag: 'gig' },
  });
  const t0 = Date.now() - 60_000;
  s.dir = dir;
  s.startedAt = t0;
  s.connection = { receiver: { speaking: { users: new Map() } }, destroy() {} };

  assert.equal(s.recordMessage(fakeMessage({ id: '0', at: t0 - 1000, text: 'before' })), false, 'posted before the start');
  assert.ok(s.recordMessage(fakeMessage({ id: '2', at: t0 + 20_000, channel: 'dice', author: 'Avrae', authorId: 'd', bot: true, text: 'Ferren rolls 17' })));
  assert.ok(s.recordMessage(fakeMessage({ id: '1', at: t0 + 5_000, text: 'Map:', files: [{ name: 'map.png', url: 'https://cdn/map.png' }] })));
  assert.equal(s.recordMessage(fakeMessage({ id: '3', at: t0 + 6_000 })), false, 'nothing to keep');
  s.pause('Gig');
  assert.equal(s.recordMessage(fakeMessage({ id: '4', at: Date.now(), text: 'off the record' })), false, 'paused');
  s.resume();
  assert.equal(s.snapshot.chat, 2);
  assert.match(describe(s.snapshot), /2 chat message\(s\) so far/);

  const res = await s.stop('stopped');
  assert.equal(s.recordMessage(fakeMessage({ id: '5', at: Date.now(), text: 'after' })), false, 'stopped');
  assert.deepEqual(res.chat.map((m) => m.messageId), ['1', '2'], 'in time order');
  assert.deepEqual(res.chat[1], {
    atMs: 20_000, messageId: '2', channelId: 't1', channel: 'dice', authorId: 'd', author: 'Avrae', bot: true, text: 'Ferren rolls 17', attachments: [],
  });

  const logged = readFileSync(join(dir, 'chat.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).messageId);
  assert.deepEqual(logged, ['2', '1'], 'chat.jsonl written as messages arrive');
  const json = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8'));
  assert.equal(json.chat.length, 2);
  const md = readFileSync(join(dir, 'transcript.md'), 'utf8');
  assert.match(md, /- Chat: 2 message\(s\) in 1 text channel\(s\), marked 💬/);
  assert.match(md, /💬 \*\*\[00:00:05\] Ferren in #general:\*\* Map: \[map\.png\]\(https:\/\/cdn\/map\.png\)\n\n💬 \*\*\[00:00:20\] Avrae in #dice:\*\* Ferren rolls 17/);
});

test('markdown interleaves chat with speech by time', () => {
  const lines = buildLines([
    { offsetMs: 1000, speakerId: 'a', speaker: 'Gig', segments: [{ start: 0, end: 1, text: 'Roll for it.' }] },
    { offsetMs: 9000, speakerId: 'a', speaker: 'Gig', segments: [{ start: 0, end: 1, text: 'Nice.' }] },
  ]);
  const chat = [{ atMs: 4000, channelId: 't', channel: 'dice', author: 'Ferren', text: 'rolled 17\nwith advantage', attachments: [] }];
  const md = toMarkdown({ guildName: 'R', channelName: 'C', startedAt: '2026-09-24T20:00:00.000Z', durationMs: 10_000 }, lines, chat);
  assert.match(md, /Roll for it\.\n\n💬 \*\*\[00:00:04\] Ferren in #dice:\*\* rolled 17 ⏎ with advantage\n\n\*\*\[00:00:09\] Gig:\*\* Nice\./);
});

test('a /roll made while recording goes in the chat, credited to the roller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-roll-'));
  const guild = { id: 'g', name: 'Realm', members: { cache: new Map() } };
  const s = new RecordingSession({
    cfg: { ffmpeg: 'ffmpeg', minClipMs: 400, silenceMs: 800, maxClipMs: 30_000 },
    transcriber: {},
    voiceChannel: { id: 'v', name: 'Council', guild },
    textChannel: {},
    startedBy: { tag: 'gig' },
  });
  const t0 = Date.now() - 60_000;
  s.dir = dir;
  s.startedAt = t0;
  s.connection = { receiver: { speaking: { users: new Map() } }, destroy() {} };

  const user = { id: 'b', displayName: 'Ferren', username: 'ferren' };
  const channel = { id: 't2', name: 'dice' };
  assert.equal(s.recordRoll({ at: t0 - 1, channel, user, text: 'early' }), false, 'before the start');
  assert.ok(s.recordRoll({ at: t0 + 7_000, messageId: 'm', channel, user, text: '🎲 rolled `d20`: [17] = **17**' }));
  s.pause('Gig');
  assert.equal(s.recordRoll({ channel, user, text: 'hidden' }), false, 'paused');
  s.resume();

  const res = await s.stop('stopped');
  assert.equal(s.recordRoll({ channel, user, text: 'late' }), false, 'stopped');
  assert.deepEqual(res.chat, [
    { atMs: 7_000, messageId: 'm', channelId: 't2', channel: 'dice', authorId: 'b', author: 'Ferren', bot: false, text: '🎲 rolled `d20`: [17] = **17**', attachments: [] },
  ]);
  assert.match(readFileSync(join(dir, 'transcript.md'), 'utf8'), /💬 \*\*\[00:00:07\] Ferren in #dice:\*\* 🎲 rolled `d20`/);
});
