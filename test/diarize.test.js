import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerClusters, cosineSimilarity, rawSpeakerId } from '../src/diarize.js';

const A = [1, 0, 0];
const A2 = [0.9, 0.1, 0]; // close to A
const B = [0, 1, 0]; // far from A

test('cosineSimilarity: identical is 1, orthogonal is 0, a zero vector is 0', () => {
  assert.equal(cosineSimilarity(A, A), 1);
  assert.equal(cosineSimilarity(A, B), 0);
  assert.equal(cosineSimilarity(A, [0, 0, 0]), 0);
});

test('rawSpeakerId strips a party-member suffix, and passes a plain Discord id through', () => {
  assert.equal(rawSpeakerId('123456'), '123456');
  assert.equal(rawSpeakerId('123456:Bob'), '123456');
  assert.equal(rawSpeakerId('123456:Bob:Jones'), '123456'); // only the first ':' counts
});

test('the first clip always starts a cluster, named after the first declared member', () => {
  const c = new SpeakerClusters(['Alice', 'Bob']);
  assert.deepEqual(c.assign(A), { name: 'Alice', index: 0 });
  assert.equal(c.clusters.length, 1);
});

test('a clearly different voice starts a new cluster, taking the next unused name', () => {
  const c = new SpeakerClusters(['Alice', 'Bob'], [], 0.9);
  c.assign(A);
  assert.deepEqual(c.assign(B), { name: 'Bob', index: 1 });
});

test('a voice close to an existing cluster joins it instead of spawning a new one', () => {
  const c = new SpeakerClusters(['Alice', 'Bob'], [], 0.5);
  c.assign(A);
  assert.deepEqual(c.assign(A2), { name: 'Alice', index: 0 });
  assert.equal(c.clusters.length, 1, 'still one cluster');
  assert.equal(c.clusters[0].count, 2);
});

test('once every declared name has a cluster, a new voice still lands in the nearest one', () => {
  const c = new SpeakerClusters(['Alice', 'Bob'], [], 0.99); // near-impossible threshold
  c.assign(A);
  c.assign(B);
  assert.equal(c.clusters.length, 2, 'capped at the declared names');
  const { name } = c.assign([0.8, 0.2, 0]); // closer to A than B
  assert.equal(name, 'Alice');
});

test('a single declared name puts every clip under it', () => {
  const c = new SpeakerClusters(['Solo'], [], 0.1);
  assert.equal(c.assign(A).name, 'Solo');
  assert.equal(c.assign(B).name, 'Solo');
  assert.equal(c.clusters.length, 1);
});

test('state round-trips through restore, and clustering carries on consistently', () => {
  const c = new SpeakerClusters(['Alice', 'Bob'], [], 0.9);
  c.assign(A);
  c.assign(B);
  const restored = SpeakerClusters.restore(c.state, 0.9);
  assert.deepEqual(restored.state, c.state);
  // A clip close to Alice's restored centroid still joins Alice, not a third cluster.
  assert.equal(restored.assign(A2).name, 'Alice');
  assert.equal(restored.clusters.length, 2);
});
