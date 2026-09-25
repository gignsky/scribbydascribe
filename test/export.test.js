import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceFor, exportRows, listSessions, renderExport, COLUMNS } from '../src/export.js';
import { toJson } from '../src/output.js';

function session(dir, folder, meta, lines) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, 'transcript.json'), toJson(meta, lines, []));
}

const meta = (guildId, channelId, channelName, startedAtMs) => ({
  guildId, guildName: 'Realm', channelId, channelName,
  startedAt: new Date(startedAtMs).toISOString(), startedAtMs, durationMs: 3_725_000,
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-export-'));
  const t0 = Date.UTC(2026, 8, 20, 20, 0, 0);
  const t1 = Date.UTC(2026, 8, 24, 20, 0, 0);
  session(dir, 'older_Council', meta('g1', 'c1', 'Council', t0), [
    { startMs: 5000, endMs: 6000, speakerId: 'b', speaker: 'Ferren', text: 'Aye, "so" be it, then.' },
    { startMs: 1000, endMs: 2000, speakerId: 'a', speaker: 'Gig', text: 'Order.' },
  ]);
  session(dir, 'newer_Tavern', meta('g1', 'c2', 'Tavern', t1), [
    { startMs: 0, endMs: 1000, speakerId: 'a', speaker: 'Gig', text: 'Line one\nline two' },
  ]);
  session(dir, 'other_server', meta('g2', 'c9', 'Elsewhere', t1), [{ startMs: 0, endMs: 1, speakerId: 'x', speaker: 'X', text: 'no' }]);
  mkdirSync(join(dir, 'still_recording')); // no transcript.json yet
  writeFileSync(join(dir, 'stray.txt'), 'not a session');
  return { dir, t0, t1 };
}

test('listSessions returns only this server\'s finished sessions, newest first', async () => {
  const { dir, t0, t1 } = fixture();
  const list = await listSessions(dir, 'g1');
  assert.deepEqual(list.map((s) => s.folder), ['newer_Tavern', 'older_Council']);
  assert.deepEqual(list.map((s) => s.key), [`${t1}-c2`, `${t0}-c1`]);
  assert.deepEqual(await listSessions(join(dir, 'missing'), 'g1'), []);
});

test('choiceFor fits Discord\'s option limits', async () => {
  const { dir } = fixture();
  const [newer] = await listSessions(dir, 'g1');
  assert.deepEqual(choiceFor(newer), {
    label: 'Tavern · 2026-09-24 20:00 UTC',
    description: '1h02m, 1 speaker(s), 1 line(s)',
    value: newer.key,
  });
  const long = choiceFor({ ...newer, channelName: 'x'.repeat(200) });
  assert.ok(long.label.length <= 100 && long.description.length <= 100);
});

test('exportRows flattens the chosen sessions in absolute time order', async () => {
  const { dir } = fixture();
  const rows = exportRows(await listSessions(dir, 'g1'));
  assert.deepEqual(rows.map((r) => [r.session, r.speaker, r.start_at]), [
    ['older_Council', 'Gig', '2026-09-20T20:00:01.000Z'],
    ['older_Council', 'Ferren', '2026-09-20T20:00:05.000Z'],
    ['newer_Tavern', 'Gig', '2026-09-24T20:00:00.000Z'],
  ]);
  assert.deepEqual(Object.keys(rows[0]), COLUMNS);
});

test('renderExport writes valid jsonl and csv', async () => {
  const { dir } = fixture();
  const rows = exportRows(await listSessions(dir, 'g1'));

  const jsonl = renderExport(rows, 'jsonl').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.equal(jsonl.length, 3);
  assert.equal(jsonl[2].text, 'Line one\nline two');

  const csv = renderExport(rows, 'csv');
  assert.ok(csv.startsWith(COLUMNS.join(',') + '\r\n'));
  assert.match(csv, /,"Aye, ""so"" be it, then\."\r\n/);
  assert.match(csv, /,"Line one\nline two"\r\n$/);
  assert.equal(renderExport([], 'jsonl'), '');
});
