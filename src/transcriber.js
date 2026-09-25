// Drives the long-lived Python faster-whisper worker. The model loads once;
// clips are then fed to it one JSON line at a time over stdin.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/**
 * How fast the worker gets through audio, as audio ms per wall ms of work,
 * weighted towards recent clips. Idle time is not counted, so it stays true
 * whether the queue has been empty or full.
 */
export class Throughput {
  #audioMs = 0;
  #busyMs = 0;

  constructor(decay = 0.8) {
    this.decay = decay;
  }

  record(audioMs, busyMs) {
    if (!(audioMs > 0) || !(busyMs > 0)) return;
    this.#audioMs = this.#audioMs * this.decay + audioMs;
    this.#busyMs = this.#busyMs * this.decay + busyMs;
  }

  /** @returns {number | null} null until a clip has been timed */
  get rate() {
    return this.#busyMs > 0 ? this.#audioMs / this.#busyMs : null;
  }
}

export class Transcriber extends EventEmitter {
  #cfg;
  #proc = null;
  #pending = new Map();
  #nextId = 1;
  #closing = false;
  #lastDoneAt = 0; // when the worker last finished a clip (or became ready)
  throughput = new Throughput();
  ready = false;

  constructor(cfg) {
    super();
    this.#cfg = cfg;
  }

  start() {
    const c = this.#cfg;
    this.#proc = spawn(c.python, [c.workerScript], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        WHISPER_MODEL: c.whisperModel,
        WHISPER_DEVICE: c.whisperDevice,
        WHISPER_COMPUTE_TYPE: c.whisperCompute,
        WHISPER_LANGUAGE: c.whisperLanguage,
        WHISPER_THREADS: String(c.whisperThreads),
      },
    });

    createInterface({ input: this.#proc.stdout }).on('line', (line) => this.#onLine(line));

    this.#proc.on('exit', (code, signal) => {
      this.ready = false;
      for (const { reject } of this.#pending.values()) {
        reject(new Error(`transcription worker exited (${code ?? signal})`));
      }
      this.#pending.clear();
      if (!this.#closing) {
        console.error(`[transcriber] worker died (${code ?? signal}); restarting in 5 s`);
        setTimeout(() => this.start(), 5000);
      }
    });
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[transcriber] unparseable line from worker:', line);
      return;
    }
    if (msg.ready) {
      this.ready = true;
      this.#lastDoneAt = Date.now();
      console.log(`[transcriber] model ready (${msg.model} on ${msg.device})`);
      this.emit('ready');
      return;
    }
    const job = this.#pending.get(msg.id);
    if (!job) return;
    this.#pending.delete(msg.id);
    // The worker takes one clip at a time, so this one started when it was
    // sent or when the one before it finished, whichever was later.
    const now = Date.now();
    if (!msg.error) this.throughput.record(job.audioMs, now - Math.max(job.sentAt, this.#lastDoneAt));
    this.#lastDoneAt = now;
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg);
  }

  /**
   * @param {string} wavPath
   * @param {number} [audioMs] the clip's length, to measure throughput
   * @returns {Promise<{segments: {start:number,end:number,text:string}[], language?: string}>}
   */
  transcribe(wavPath, audioMs = 0) {
    if (!this.#proc || this.#proc.exitCode !== null) {
      return Promise.reject(new Error('transcription worker is not running'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, audioMs, sentAt: Date.now() });
      this.#proc.stdin.write(JSON.stringify({ id, path: wavPath }) + '\n');
    });
  }

  get queued() {
    return this.#pending.size;
  }

  /** Audio ms per wall ms, or null before the first clip is timed. */
  get rate() {
    return this.throughput.rate;
  }

  stop() {
    this.#closing = true;
    this.#proc?.stdin.end();
  }
}
