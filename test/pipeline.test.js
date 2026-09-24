// End to end, minus Discord itself: speech is Opus-encoded exactly as a
// Discord client sends it (48 kHz stereo, 20 ms frames), then run through the
// bot's decoder, clip builder, faster-whisper worker and transcript writer.
// Needs espeak-ng and python faster_whisper; skipped when they are missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import prism from 'prism-media';
import OpusScript from 'opusscript';
import { ClipBuilder, stereoToMono, toWav } from '../src/audio.js';
import { Transcriber } from '../src/transcriber.js';
import { buildLines, toMarkdown } from '../src/output.js';
import { loadConfig } from '../src/config.js';

const have = (cmd, args) => spawnSync(cmd, args).status === 0;
const ready = !process.env.SCRIVENER_SKIP_E2E && have('espeak-ng', ['--version']) && have('python3', ['-c', 'import faster_whisper']);

function speak(text, voice) {
  // espeak -> 48 kHz stereo s16le, the format Discord clients encode from.
  const wav = execFileSync('espeak-ng', ['-v', voice, '-s', '150', '--stdout', text]);
  return execFileSync('ffmpeg', ['-v', 'error', '-i', '-', '-f', 's16le', '-ar', '48000', '-ac', '2', '-'], { input: wav });
}

function opusPackets(stereoPcm) {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const frameBytes = 960 * 2 * 2;
  const packets = [];
  for (let o = 0; o + frameBytes <= stereoPcm.length; o += frameBytes) {
    packets.push(Buffer.from(enc.encode(stereoPcm.subarray(o, o + frameBytes), 960)));
  }
  enc.delete();
  return packets;
}

/** Decode packets the way session.js does, stamping each with a fake arrival time. */
async function receive(packets, startMs) {
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const builder = new ClipBuilder(startMs - 20);
  let t = startMs;
  decoder.on('data', (stereo) => builder.push(stereoToMono(stereo), (t += 20)));
  const done = new Promise((r) => decoder.on('end', r));
  for (const p of packets) decoder.write(p);
  decoder.end();
  decoder.resume();
  await done;
  return builder;
}

test('speech survives Opus → clip → whisper → transcript', { skip: !ready && 'espeak-ng / faster_whisper missing', timeout: 600_000 }, async () => {
  process.env.DISCORD_TOKEN ??= 'test';
  const cfg = { ...loadConfig(), whisperModel: process.env.WHISPER_MODEL || 'small' };
  const dir = mkdtempSync(join(tmpdir(), 'scrivener-e2e-'));
  const t = new Transcriber(cfg);
  t.start();

  const sessionStart = 1_000_000;
  const turns = [
    { id: '1', name: 'Lord Gig', voice: 'en-us', at: 1_000, text: 'Good evening everyone, the council is now in session.' },
    { id: '2', name: 'Ferren', voice: 'en-gb+m3', at: 6_000, text: 'Thank you. The first item is the budget for the new server.' },
  ];

  const entries = [];
  for (const turn of turns) {
    const builder = await receive(opusPackets(speak(turn.text, turn.voice)), sessionStart + turn.at);
    const file = join(dir, `${turn.id}.wav`);
    writeFileSync(file, toWav(builder.pcm()));
    const res = await t.transcribe(file);
    entries.push({ offsetMs: builder.startMs - sessionStart, speakerId: turn.id, speaker: turn.name, segments: res.segments });
  }
  t.stop();

  const lines = buildLines(entries);
  const md = toMarkdown({ guildName: 'Realm', channelName: 'Council', startedAt: new Date(0).toISOString(), durationMs: 12_000 }, lines);
  console.log(md);

  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '');
  const gig = norm(lines.filter((l) => l.speaker === 'Lord Gig').map((l) => l.text).join(' '));
  const ferren = norm(lines.filter((l) => l.speaker === 'Ferren').map((l) => l.text).join(' '));
  assert.match(gig, /good evening/);
  assert.match(ferren, /budget/);
  assert.ok(!gig.includes('budget') && !ferren.includes('good evening'), 'speakers kept apart');
  assert.equal(lines[0].speaker, 'Lord Gig');
  assert.ok(Math.abs(lines[0].startMs - 1000) < 300, `first line at ${lines[0].startMs} ms`);
  assert.ok(Math.abs(lines.find((l) => l.speaker === 'Ferren').startMs - 6000) < 300);
});
