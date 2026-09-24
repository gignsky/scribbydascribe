// Drives the long-lived Python faster-whisper worker. The model loads once;
// clips are then fed to it one JSON line at a time over stdin.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class Transcriber extends EventEmitter {
  #cfg;
  #proc = null;
  #pending = new Map();
  #nextId = 1;
  #closing = false;
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
      console.log(`[transcriber] model ready (${msg.model} on ${msg.device})`);
      this.emit('ready');
      return;
    }
    const job = this.#pending.get(msg.id);
    if (!job) return;
    this.#pending.delete(msg.id);
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg);
  }

  /**
   * @param {string} wavPath
   * @returns {Promise<{segments: {start:number,end:number,text:string}[], language?: string}>}
   */
  transcribe(wavPath) {
    if (!this.#proc || this.#proc.exitCode !== null) {
      return Promise.reject(new Error('transcription worker is not running'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#proc.stdin.write(JSON.stringify({ id, path: wavPath }) + '\n');
    });
  }

  get queued() {
    return this.#pending.size;
  }

  stop() {
    this.#closing = true;
    this.#proc?.stdin.end();
  }
}
