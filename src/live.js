// Pieces of the live CLI that need no I/O: cutting a continuous audio stream
// into clips at pauses, and formatting transcript lines.
//
// Audio here is 16-bit signed little-endian mono PCM. The CLI captures it at
// 16 kHz (what Whisper wants), not the 48 kHz the Discord bot works in.

export const LIVE_SAMPLE_RATE = 16_000;

function rms(frame) {
  const n = frame.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Cuts a continuous stream into clips: a clip starts at the first loud frame
 * (with a little lead-in kept) and ends after `silenceMs` of quiet, or is cut
 * at `maxMs` so a long monologue still shows up as it is said. Time is the
 * stream's own (samples seen), never the wall clock, so a file replays the
 * same as a microphone.
 */
export class Endpointer {
  #frameBytes;
  #leftover = Buffer.alloc(0);
  #pos = 0; // samples consumed
  #preRoll = [];
  #clip = null;

  /**
   * @param {(clip: {startMs: number, durationMs: number, pcm: Buffer}) => void} onClip
   * @param {object} [opts]
   * @param {number} [opts.sampleRate]
   * @param {number} [opts.frameMs]
   * @param {number} [opts.threshold] RMS (of 32768) above which a frame is speech
   * @param {number} [opts.silenceMs] quiet that ends a clip
   * @param {number} [opts.maxMs] longest clip before it is cut mid-speech
   * @param {number} [opts.minMs] least speech a clip needs to be kept
   * @param {number} [opts.preRollMs] quiet kept before the first loud frame
   */
  constructor(onClip, opts = {}) {
    const o = { sampleRate: LIVE_SAMPLE_RATE, frameMs: 20, threshold: 200, silenceMs: 700, maxMs: 10_000, minMs: 300, preRollMs: 200, ...opts };
    this.o = o;
    this.onClip = onClip;
    this.frameSamples = Math.round((o.sampleRate * o.frameMs) / 1000);
    this.#frameBytes = this.frameSamples * 2;
    this.preRollFrames = Math.round(o.preRollMs / o.frameMs);
  }

  push(buf) {
    let data = this.#leftover.length ? Buffer.concat([this.#leftover, buf]) : buf;
    let off = 0;
    while (data.length - off >= this.#frameBytes) {
      this.#frame(data.subarray(off, off + this.#frameBytes));
      off += this.#frameBytes;
    }
    this.#leftover = Buffer.from(data.subarray(off));
  }

  /** End of input: emit the clip in progress, if it holds enough speech. */
  flush() {
    this.#end(0);
  }

  #frame(frame) {
    const loud = rms(frame) > this.o.threshold;
    const c = this.#clip;
    if (!c) {
      if (loud) {
        this.#clip = {
          startSample: this.#pos - this.#preRoll.length * this.frameSamples,
          frames: [...this.#preRoll, frame],
          loud: 1,
          quiet: 0,
        };
        this.#preRoll = [];
      } else {
        this.#preRoll.push(frame);
        if (this.#preRoll.length > this.preRollFrames) this.#preRoll.shift();
      }
    } else {
      c.frames.push(frame);
      if (loud) {
        c.loud++;
        c.quiet = 0;
      } else {
        c.quiet++;
      }
      if (c.quiet * this.o.frameMs >= this.o.silenceMs) this.#end(c.quiet);
      else if (c.frames.length * this.o.frameMs >= this.o.maxMs) this.#end(0);
    }
    this.#pos += this.frameSamples;
  }

  // trailingQuiet: frames of silence at the end of the clip. Most are dropped,
  // leaving a short tail so words are not clipped.
  #end(trailingQuiet) {
    const c = this.#clip;
    this.#clip = null;
    this.#preRoll = [];
    if (!c) return;
    const keepTail = Math.min(trailingQuiet, this.preRollFrames);
    const frames = c.frames.slice(0, c.frames.length - trailingQuiet + keepTail);
    if (c.loud * this.o.frameMs < this.o.minMs) return;
    const pcm = Buffer.concat(frames);
    this.onClip({
      startMs: Math.round((c.startSample * 1000) / this.o.sampleRate),
      durationMs: Math.round((pcm.length / 2 / this.o.sampleRate) * 1000),
      pcm,
    });
  }
}

/** 3725000 -> "01:02:05" */
export function formatOffset(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * One transcript line, ending in a newline so it goes out in a single write.
 * Markdown (the default) bolds the stamp and ends with a blank line so each
 * utterance is its own paragraph; txt is one plain line each.
 */
export function formatLine(offsetMs, label, text, format = 'md') {
  const one = text.replace(/\s+/g, ' ').trim();
  const stamp = `[${formatOffset(offsetMs)}]${label ? ` ${label}:` : ''}`;
  return format === 'md' ? `**${stamp}** ${one}\n\n` : `${stamp} ${one}\n`;
}

/** The line that opens each run in the file. `first`: the file is new or emptied. */
export function formatHeader(startedAt, detail, format = 'md', first = true) {
  const when = startedAt.toString();
  if (format !== 'md') return `# scribby-live started ${when} (${detail}); times below count from this moment\n`;
  return `${first ? '#' : '\n---\n\n##'} Live transcript, started ${when}\n\n_${detail}. Times count from this moment._\n\n`;
}

/** Parse repeatable `-s` values: "label=device", or a bare device (label = device). */
export function parseSource(spec) {
  const i = spec.indexOf('=');
  if (i < 0) return { label: spec === 'default' ? 'mic' : spec, device: spec };
  return { label: spec.slice(0, i), device: spec.slice(i + 1) || 'default' };
}
