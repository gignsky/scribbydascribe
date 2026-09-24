import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClipBuilder, stereoToMono, toWav, wavPayload, SAMPLES_PER_MS } from '../src/audio.js';

const frame = (ms = 20, value = 1000) => {
  const b = Buffer.alloc(ms * SAMPLES_PER_MS * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};

test('stereoToMono averages channels', () => {
  const s = Buffer.alloc(8);
  s.writeInt16LE(100, 0); s.writeInt16LE(300, 2);
  s.writeInt16LE(-200, 4); s.writeInt16LE(-400, 6);
  const m = stereoToMono(s);
  assert.equal(m.length, 4);
  assert.equal(m.readInt16LE(0), 200);
  assert.equal(m.readInt16LE(2), -300);
});

test('toWav writes a valid header and payload', () => {
  const pcm = frame(20);
  const wav = toWav(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wavPayload(wav), pcm);
});

test('ClipBuilder: steady 20 ms frames add no padding', () => {
  const b = new ClipBuilder(1000);
  for (let i = 1; i <= 50; i++) b.push(frame(), 1000 + i * 20 + (i % 3)); // a little jitter
  assert.equal(b.durationMs, 1000);
});

test('ClipBuilder: a 500 ms pause inside an utterance is kept as silence', () => {
  const b = new ClipBuilder(0);
  for (let i = 1; i <= 10; i++) b.push(frame(), i * 20); // 0–200 ms speech
  for (let i = 1; i <= 10; i++) b.push(frame(), 700 + i * 20); // resumes at 700 ms
  assert.ok(Math.abs(b.durationMs - 900) <= 1, `duration ${b.durationMs}`);
  const pcm = b.pcm();
  const at = (ms) => pcm.readInt16LE(Math.round(ms * SAMPLES_PER_MS) * 2);
  assert.equal(at(100), 1000);
  assert.equal(at(450), 0);
  assert.equal(at(800), 1000);
});
