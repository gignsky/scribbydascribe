import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLines, buildTracks, clock, paragraphs, safeName, toMarkdown, toSrt } from '../src/output.js';
import { toWav, SAMPLES_PER_MS } from '../src/audio.js';

const entries = [
  { offsetMs: 5000, speakerId: 'b', speaker: 'Ferren', segments: [{ start: 0, end: 2, text: 'Aye.' }] },
  { offsetMs: 1000, speakerId: 'a', speaker: 'Gig', segments: [
    { start: 0, end: 1.5, text: 'Good evening.' },
    { start: 1.6, end: 3, text: 'Let us begin.' },
  ] },
];

test('buildLines places segments on the session timeline in order', () => {
  const lines = buildLines(entries);
  assert.deepEqual(lines.map((l) => [l.startMs, l.speaker]), [[1000, 'Gig'], [2600, 'Gig'], [5000, 'Ferren']]);
});

test('paragraphs joins a speaker\'s adjacent lines only', () => {
  const p = paragraphs(buildLines(entries));
  assert.equal(p.length, 2);
  assert.equal(p[0].text, 'Good evening. Let us begin.');
});

test('markdown and srt render', () => {
  const lines = buildLines(entries);
  const md = toMarkdown({ guildName: 'Realm', channelName: 'Council', startedAt: '2026-09-24T20:00:00.000Z', durationMs: 7000 }, lines);
  assert.match(md, /\*\*\[00:00:01\] Gig:\*\* Good evening\. Let us begin\./);
  assert.match(md, /\*\*\[00:00:05\] Ferren:\*\* Aye\./);
  const srt = toSrt(lines);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:02,500\nGig: Good evening\.\n/);
  assert.equal(clock(3_723_000), '01:02:03');
});

test('safeName keeps names readable and filesystem-safe', () => {
  assert.equal(safeName('Lord Gig ✨'), 'Lord_Gig');
  assert.equal(safeName('../../etc'), '.._.._etc');
  assert.equal(safeName('   '), 'speaker');
});

const ffprobeSeconds = (f) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

test('buildTracks writes aligned per-speaker tracks and a mix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-'));
  mkdirSync(join(dir, 'clips'));
  mkdirSync(join(dir, 'tracks'));
  const tone = (ms) => {
    const b = Buffer.alloc(ms * SAMPLES_PER_MS * 2);
    for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
    return b;
  };
  const clips = [
    { speakerId: 'a', offsetMs: 500, durationMs: 1000, file: 'clips/a1.wav' },
    { speakerId: 'b', offsetMs: 2000, durationMs: 1000, file: 'clips/b1.wav' },
    { speakerId: 'a', offsetMs: 2600, durationMs: 1000, file: 'clips/a2.wav' }, // overlaps b
  ];
  for (const c of clips) writeFileSync(join(dir, c.file), toWav(tone(c.durationMs)));

  const out = await buildTracks({
    ffmpeg: 'ffmpeg', sessionDir: dir, clips,
    speakers: new Map([['a', 'Lord Gig'], ['b', 'Ferren']]),
    durationMs: 5000,
  });
  assert.deepEqual(out.map((o) => o.split('/').at(-1)), ['Lord_Gig.ogg', 'Ferren.ogg']);
  for (const f of [...out, join(dir, 'tracks', 'mix.ogg')]) {
    assert.ok(Math.abs(ffprobeSeconds(f) - 5) < 0.05, `${f} is ${ffprobeSeconds(f)} s`);
  }

  // Loudness in windows: Gig's track is silent while only Ferren speaks.
  const rms = (f, from, len) => {
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(from), '-t', String(len), '-i', f, '-f', 's16le', '-ac', '1', '-ar', '48000', '-']);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    return Math.sqrt(sum / (pcm.length / 2));
  };
  const [gig, ferren] = out;
  assert.ok(rms(gig, 0.7, 0.5) > 1000, 'Gig audible at 0.7 s');
  assert.ok(rms(gig, 2.1, 0.4) < 50, 'Gig silent at 2.1 s');
  assert.ok(rms(ferren, 2.1, 0.4) > 1000, 'Ferren audible at 2.1 s');
  assert.ok(rms(ferren, 4.0, 0.5) < 50, 'Ferren silent at 4 s');
});
