import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PARTY_MEMBERS, MIN_PARTY_MEMBERS, clearMembers, getMembers, parseNames, setMembers } from '../src/transpose.js';

function dir() {
  return mkdtempSync(join(tmpdir(), 'scribbydascribe-transpose-'));
}

test('parseNames trims, drops empties, and dedupes case-insensitively', () => {
  assert.deepEqual(parseNames(' Alice ,, Bob , alice ,Cara'), ['Alice', 'Bob', 'Cara']);
});

test('parseNames rejects too few or too many names', () => {
  assert.throws(() => parseNames('Alice'), /at least 2/);
  assert.throws(() => parseNames(''), /at least 2/);
  const many = Array.from({ length: MAX_PARTY_MEMBERS + 1 }, (_, i) => `P${i}`).join(',');
  assert.throws(() => parseNames(many), /at most 8/);
});

test('parseNames rejects a name that is too long', () => {
  assert.throws(() => parseNames(`Alice, ${'x'.repeat(40)}`), /too long/);
});

test(`MIN/MAX_PARTY_MEMBERS stay what the error messages above claim`, () => {
  assert.equal(MIN_PARTY_MEMBERS, 2);
  assert.equal(MAX_PARTY_MEMBERS, 8);
});

test('getMembers is null until declared, then round-trips through set/clear', async () => {
  const d = dir();
  assert.equal(await getMembers(d, 'g1', 'u1'), null);
  await setMembers(d, 'g1', 'u1', ['Alice', 'Bob']);
  assert.deepEqual(await getMembers(d, 'g1', 'u1'), ['Alice', 'Bob']);

  assert.equal(await clearMembers(d, 'g1', 'u1'), true);
  assert.equal(await getMembers(d, 'g1', 'u1'), null);
  assert.equal(await clearMembers(d, 'g1', 'u1'), false, 'clearing twice reports nothing was there');
});

test('rosters do not leak across guilds or users', async () => {
  const d = dir();
  await setMembers(d, 'g1', 'u1', ['Alice', 'Bob']);
  await setMembers(d, 'g1', 'u2', ['Cara', 'Dan']);
  await setMembers(d, 'g2', 'u1', ['Eve', 'Finn']);

  assert.deepEqual(await getMembers(d, 'g1', 'u1'), ['Alice', 'Bob']);
  assert.deepEqual(await getMembers(d, 'g1', 'u2'), ['Cara', 'Dan']);
  assert.deepEqual(await getMembers(d, 'g2', 'u1'), ['Eve', 'Finn']);
  assert.equal(await getMembers(d, 'g2', 'u2'), null);

  await clearMembers(d, 'g1', 'u1');
  assert.deepEqual(await getMembers(d, 'g1', 'u2'), ['Cara', 'Dan'], 'clearing one user leaves the rest of the guild alone');
  assert.deepEqual(await getMembers(d, 'g2', 'u1'), ['Eve', 'Finn'], 'and leaves other guilds alone');
});

test('getMembers on a missing data dir is just null, not an error', async () => {
  assert.equal(await getMembers(join(dir(), 'missing'), 'g1', 'u1'), null);
});
