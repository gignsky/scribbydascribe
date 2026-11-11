#!/usr/bin/env node
// scribby-live: live speech-to-text from a microphone (or any PulseAudio /
// PipeWire source) into a plain text file that grows as people speak, so
// another program (Claude, `tail -f`) can read it while it is being written.
//
// The file only ever grows: one complete line per utterance, written in a
// single append. Nothing is rewritten, so a reader never sees a half line.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync, statSync, createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadWorkerConfig } from './config.js';
import { Transcriber } from './transcriber.js';
import { wavHeader } from './audio.js';
import { Endpointer, LIVE_SAMPLE_RATE, formatLine, formatHeader, parseSource } from './live.js';

const HELP = `scribby-live: live transcript of what a microphone hears, in a text file.

  scribby-live [options]

  -o, --output FILE     transcript file (default ./live-transcript.md). Appended to.
      --format md|txt  Markdown (default) or plain lines; a .txt FILE implies txt
      --fresh           start the file empty instead of appending
      --no-follow       don't also show new lines on the terminal as they are written
                        (on by default when stdout is a terminal, like tail -f; --follow forces it)
  -s, --source SPEC     what to listen to; repeat for several. SPEC is
                        label=device, e.g. -s me=default -s them=<name>.monitor
                        ("pactl list short sources" lists devices). Default: mic=default
  -f, --file PATH       read raw 16 kHz mono s16le audio from PATH ("-" = stdin)
                        instead of a microphone
  -m, --model NAME      Whisper model: tiny, base, small, medium... (default small)
  -l, --language CODE   spoken language, or "auto" (default en)
      --translate       write English text for speech in any language
      --silence MS      quiet that ends an utterance (default 700)
      --max-clip MS     longest utterance before it is cut (default 10000)
      --threshold N     loudness (0-32768) that counts as speech (default 200)
  -h, --help

Each utterance is "**[HH:MM:SS] label:** text" (plain: "[HH:MM:SS] label: text"), the time counted from when the run started
(the first line of each run says when that was). Ctrl-C finishes what was heard.
Status goes to stderr.
`;

// The worker and recorder are Nix-built and find their own libraries. A
// LD_LIBRARY_PATH inherited from the shell (e.g. a dev shell's alsa-lib built
// against a newer glibc) makes them load the wrong ones and fail to start.
delete process.env.LD_LIBRARY_PATH;

// stdout is the transcript (see --follow); the Transcriber's own console.log
// status lines belong on stderr with the rest.
console.log = console.error;

const log = (...a) => console.error('[scribby-live]', ...a);

const { values: v } = parseArgs({
  options: {
    output: { type: 'string', short: 'o', default: 'live-transcript.md' },
    format: { type: 'string' },
    fresh: { type: 'boolean', default: false },
    follow: { type: 'boolean' },
    source: { type: 'string', short: 's', multiple: true },
    file: { type: 'string', short: 'f' },
    model: { type: 'string', short: 'm' },
    language: { type: 'string', short: 'l' },
    translate: { type: 'boolean', default: false },
    silence: { type: 'string' },
    'max-clip': { type: 'string' },
    threshold: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowNegative: true,
});

if (v.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const num = (name, raw, fallback) => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number, got "${raw}"`);
    process.exit(2);
  }
  return n;
};

const cfg = loadWorkerConfig();
if (v.model) cfg.whisperModel = v.model;
if (v.language) cfg.whisperLanguage = v.language === 'auto' ? '' : v.language;
if (v.translate) cfg.whisperTask = 'translate';

const endpointOpts = {
  silenceMs: num('silence', v.silence, 700),
  maxMs: num('max-clip', v['max-clip'], 10_000),
  threshold: num('threshold', v.threshold, 200),
};

const sources = v.file ? [{ label: '', device: null }] : (v.source?.length ? v.source : ['default']).map(parseSource);
const outPath = resolve(v.output);

// ---- output ---------------------------------------------------------------

const format = v.format ?? (/\.txt$/i.test(outPath) ? 'txt' : 'md');
if (format !== 'md' && format !== 'txt') {
  console.error(`--format must be md or txt, got "${format}"`);
  process.exit(2);
}
const detail = `model ${cfg.whisperModel}${cfg.whisperTask === 'translate' ? ', translating to English' : ''}`;
const fileHasContent = existsSync(outPath) && statSync(outPath).size > 0;
const header = formatHeader(new Date(), detail, format, v.fresh || !fileHasContent);
// Show what is written on the terminal too, as tail -f would. Status goes to
// stderr, so stdout carries only the transcript and can be piped.
const follow = v.follow ?? process.stdout.isTTY === true;
if (v.fresh) writeFileSync(outPath, header);
else appendFileSync(outPath, header);
if (follow) process.stdout.write(header);

// A single appendFileSync is a single O_APPEND write: a reader sees whole lines.
const emitLine = (offsetMs, label, text) => {
  const line = formatLine(offsetMs, label, text, format);
  appendFileSync(outPath, line);
  if (follow) process.stdout.write(line);
};

// ---- transcription --------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'scribby-live-'));
const transcriber = new Transcriber(cfg);
const inflight = new Set();
let clipSeq = 0;
let lastBacklogWarn = 0;

function onClip(label, clip) {
  const wavPath = join(workDir, `${clipSeq++}.wav`);
  const job = (async () => {
    try {
      await writeFile(wavPath, Buffer.concat([wavHeader(clip.pcm.length, LIVE_SAMPLE_RATE), clip.pcm]));
      const res = await transcriber.transcribe(wavPath, clip.durationMs);
      const text = res.segments.map((s) => s.text).join(' ');
      if (text) emitLine(clip.startMs + Math.round((res.segments[0]?.start ?? 0) * 1000), label, text);
    } catch (e) {
      log(`clip at ${clip.startMs} ms failed: ${e.message}`);
    } finally {
      unlink(wavPath).catch(() => {});
    }
  })();
  inflight.add(job);
  job.finally(() => inflight.delete(job));
  // The worker handles one clip at a time. If speech arrives faster than it is
  // transcribed the file lags; say so (not more than every 15 s).
  if (transcriber.queued >= 3 && Date.now() - lastBacklogWarn > 15_000) {
    lastBacklogWarn = Date.now();
    const rate = transcriber.rate;
    log(`falling behind: ${transcriber.queued} clips waiting${rate ? ` (transcribing at ${rate.toFixed(1)}x real time)` : ''}. A smaller --model would keep up.`);
  }
}

// ---- audio input ----------------------------------------------------------

const captures = []; // { stop(), done: Promise }

function captureCommands(device) {
  const dev = device && device !== 'default' ? device : null;
  return [
    ['parecord', ['--raw', '--format=s16le', `--rate=${LIVE_SAMPLE_RATE}`, '--channels=1', '--latency-msec=50', ...(dev ? ['-d', dev] : [])]],
    ['pw-record', ['--rate', String(LIVE_SAMPLE_RATE), '--channels', '1', '--format', 's16', ...(dev ? ['--target', dev] : []), '-']],
  ];
}

function captureDevice({ label, device }, ep) {
  const candidates = captureCommands(device);
  let child = null;
  let stopping = false;
  const done = new Promise((resolveDone) => {
    const attempt = (i) => {
      if (i >= candidates.length) {
        log(`no recorder found for "${label}": need parecord (pulseaudio) or pw-record (pipewire) on PATH`);
        process.exitCode = 1;
        return resolveDone();
      }
      const [cmd, args] = candidates[i];
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      child.once('error', (e) => (e.code === 'ENOENT' ? attempt(i + 1) : (log(`${cmd}: ${e.message}`), resolveDone())));
      child.stdout.on('data', (d) => ep.push(d));
      child.once('exit', (code, sig) => {
        if (!stopping) {
          log(`${cmd} for "${label}" exited (${code ?? sig}) before it was stopped`);
          process.exitCode = 1;
        }
        resolveDone();
      });
    };
    attempt(0);
  });
  return { done, stop: () => ((stopping = true), child?.kill('SIGTERM')) };
}

function captureFile(path, ep) {
  const input = path === '-' ? process.stdin : createReadStream(path);
  const done = new Promise((resolveDone) => {
    input.on('data', (d) => ep.push(d));
    input.on('end', resolveDone);
    input.on('error', (e) => (log(`reading ${path}: ${e.message}`), (process.exitCode = 1), resolveDone()));
  });
  return { done, stop: () => input.destroy() };
}

// ---- run ------------------------------------------------------------------

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('stopping; finishing what was heard...');
  for (const c of captures) c.stop();
  await Promise.all(captures.map((c) => c.done));
  for (const ep of endpointers) ep.flush();
  await Promise.all([...inflight]);
  transcriber.stop();
  rmSync(workDir, { recursive: true, force: true });
  log('done');
  process.exit(process.exitCode ?? 0);
}

const endpointers = [];
for (const src of sources) {
  const ep = new Endpointer((clip) => onClip(src.label, clip), endpointOpts);
  endpointers.push(ep);
  src.ep = ep;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', () => shuttingDown && process.once('SIGINT', () => process.exit(130)));

log(`writing to ${outPath}`);
log(`loading ${cfg.whisperModel} model (first run downloads it)...`);
transcriber.once('ready', () => {
  log(v.file ? `reading ${v.file}` : `listening: ${sources.map((s) => `${s.label}=${s.device}`).join(', ')}. Ctrl-C to stop.`);
  for (const src of sources) captures.push(v.file ? captureFile(v.file, src.ep) : captureDevice(src, src.ep));
  // A file or stdin ends by itself.
  if (v.file) Promise.all(captures.map((c) => c.done)).then(shutdown);
});
// A worker that dies before it ever loaded the model (missing package, no
// network for the first download) would otherwise be restarted forever.
transcriber.on('died', ({ wasReady }) => {
  if (wasReady) return; // the Transcriber restarts it; the clip in flight is reported failed
  log('the transcription worker failed to start (see its error above)');
  process.exit(1);
});
transcriber.start();
