import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DICE, parseDice, roll, rollTerms } from '../src/dice.js';

/** A die that returns the given faces in turn. */
const loaded = (...faces) => () => faces.shift();

test('parses common notation', () => {
  assert.deepEqual(parseDice('d20'), [{ sign: 1, count: 1, sides: 20 }]);
  assert.deepEqual(parseDice(' 2D6 + 3 '), [
    { sign: 1, count: 2, sides: 6 },
    { sign: 1, value: 3 },
  ]);
  assert.deepEqual(parseDice('d%-1'), [
    { sign: 1, count: 1, sides: 100 },
    { sign: -1, value: 1 },
  ]);
  assert.deepEqual(parseDice('4d6kh3')[0].keep, { high: true, n: 3 });
  assert.deepEqual(parseDice('2d20kl1')[0].keep, { high: false, n: 1 });
  assert.deepEqual(parseDice('2d20k1')[0].keep, { high: true, n: 1 });
});

test('rejects what it cannot roll', () => {
  for (const bad of ['', 'banana', '2d', 'd1', `${MAX_DICE + 1}d6`, '0d6', '2d6kh3', 'd20++2', '3d6*2']) {
    assert.throws(() => parseDice(bad), undefined, bad);
  }
});

test('sums dice and modifiers', () => {
  const r = roll('2d6+3', loaded(4, 2));
  assert.equal(r.total, 9);
  assert.equal(r.notation, '2d6 + 3');
  assert.equal(r.working, '[4, 2] + 3');
});

test('subtracts negative terms', () => {
  const r = roll('d20-d4-1', loaded(15, 3));
  assert.equal(r.total, 11);
  assert.equal(r.working, '[15] - [3] - 1');
});

test('keeps the highest or lowest dice', () => {
  const adv = roll('2d20kh1+5', loaded(4, 17));
  assert.equal(adv.total, 22);
  assert.equal(adv.working, '[~~4~~, 17] + 5');

  const dis = roll('2d20kl1', loaded(4, 17));
  assert.equal(dis.total, 4);

  // Ties drop the later die.
  const stats = roll('4d6kh3', loaded(3, 5, 3, 6));
  assert.equal(stats.total, 14);
  assert.equal(stats.working, '[3, 5, ~~3~~, 6]');
});

test('the default die stays in range', () => {
  const r = rollTerms(parseDice('100d6'));
  assert.ok(r.terms[0].faces.every((f) => Number.isInteger(f) && f >= 1 && f <= 6));
  assert.ok(r.total >= 100 && r.total <= 600);
});
