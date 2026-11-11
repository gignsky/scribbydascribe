import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Endpointer, formatHeader, formatLine, formatOffset, parseSource, LIVE_SAMPLE_RATE } from '../src/live.js';

const FRAME = (LIVE_SAMPLE_RATE * 20) / 1000;
// ms of a constant-amplitude signal (a square-ish tone is enough for RMS)
function tone(ms, amp = 3000) {
  const n = (LIVE_SAMPLE_RATE * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}
const quiet = (ms) => Buffer.alloc((LIVE_SAMPLE_RATE * ms * 2) / 1000);

function run(chunks, opts) {
  const clips = [];
  const ep = new Endpointer((c) => clips.push(c), opts);
  for (const c of chunks) ep.push(c);
  ep.flush();
  return clips;
}

test('a pause ends a clip; each clip knows where it started', () => {
  const clips = run([quiet(1000), tone(1000), quiet(1500), tone(500), quiet(1000)]);
  assert.equal(clips.length, 2);
  assert.ok(Math.abs(clips[0].startMs - 800) <= 20, `start ${clips[0].startMs}`); // 1000 minus lead-in
  assert.ok(Math.abs(clips[1].startMs - 3300) <= 20, `start ${clips[1].startMs}`);
  assert.ok(clips[0].durationMs >= 1000 && clips[0].durationMs <= 1500);
});

test('quiet shorter than the silence window does not split a clip', () => {
  const clips = run([tone(500), quiet(400), tone(500), quiet(1000)]);
  assert.equal(clips.length, 1);
});

test('a long run of speech is cut at maxMs so it appears while still being said', () => {
  const clips = run([tone(25_000)], { maxMs: 10_000 });
  assert.equal(clips.length, 3);
  assert.ok(clips[0].durationMs <= 10_000);
});

test('clicks shorter than minMs, and silence, produce no clips', () => {
  assert.equal(run([quiet(3000), tone(100), quiet(2000)]).length, 0);
});

test('input may arrive in arbitrary chunk sizes', () => {
  const whole = Buffer.concat([quiet(500), tone(1000), quiet(1500)]);
  const pieces = [];
  for (let i = 0; i < whole.length; i += 777) pieces.push(whole.subarray(i, i + 777));
  const a = run(pieces);
  const b = run([whole]);
  assert.equal(a.length, 1);
  assert.deepEqual(a.map((c) => [c.startMs, c.durationMs]), b.map((c) => [c.startMs, c.durationMs]));
});

test('flush emits speech still in progress', () => {
  const clips = run([tone(1000)]);
  assert.equal(clips.length, 1);
});

test('formatting', () => {
  assert.equal(formatOffset(3_725_000), '01:02:05');
  assert.equal(formatLine(65_000, 'mic', '  hello \n world '), '**[00:01:05] mic:** hello world\n\n');
  assert.equal(formatLine(65_000, 'mic', 'hello', 'txt'), '[00:01:05] mic: hello\n');
  assert.equal(formatLine(0, '', 'hi'), '**[00:00:00]** hi\n\n');
  assert.match(formatHeader(new Date(0), 'model tiny'), /^# Live transcript, started/);
  assert.match(formatHeader(new Date(0), 'model tiny', 'md', false), /^\n---\n\n## Live/);
  assert.deepEqual(parseSource('them=a.monitor'), { label: 'them', device: 'a.monitor' });
  assert.deepEqual(parseSource('default'), { label: 'mic', device: 'default' });
  assert.equal(FRAME, 320);
});
