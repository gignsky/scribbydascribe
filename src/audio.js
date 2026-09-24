// Small, dependency-free audio helpers. Everything here is 16-bit signed
// little-endian PCM at 48 kHz, which is what Discord's Opus decodes to.

export const SAMPLE_RATE = 48_000;
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const BYTES_PER_SAMPLE = 2;

/** Average interleaved stereo s16le down to mono s16le. */
export function stereoToMono(stereo) {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.allocUnsafe(frames * BYTES_PER_SAMPLE);
  for (let i = 0; i < frames; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    mono.writeInt16LE((l + r) >> 1, i * 2);
  }
  return mono;
}

/** A 44-byte canonical WAV header for mono s16le at 48 kHz. */
export function wavHeader(dataBytes, sampleRate = SAMPLE_RATE, channels = 1) {
  const h = Buffer.alloc(44);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // PCM format
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function toWav(monoPcm) {
  return Buffer.concat([wavHeader(monoPcm.length), monoPcm]);
}

/** PCM payload of a WAV written by toWav(). */
export function wavPayload(wav) {
  return wav.subarray(44);
}

/**
 * Collects one speaker's decoded audio for a single clip and keeps it honest
 * to the wall clock. Discord sends nothing while someone is silent, so short
 * pauses inside an utterance would otherwise vanish and the clip would drift
 * earlier than reality. When audio arrives later than the samples written so
 * far account for, the gap is filled with silence.
 */
export class ClipBuilder {
  /**
   * @param {number} startMs wall-clock ms when the clip's first audio arrived
   * @param {number} toleranceMs lateness absorbed as jitter before padding
   */
  constructor(startMs, toleranceMs = 60) {
    this.startMs = startMs;
    this.toleranceSamples = Math.round(toleranceMs * SAMPLES_PER_MS);
    this.chunks = [];
    this.samples = 0;
  }

  /**
   * @param {Buffer} monoPcm one decoded frame (usually 20 ms)
   * @param {number} arrivedMs wall-clock ms the frame arrived
   */
  push(monoPcm, arrivedMs) {
    const frameSamples = monoPcm.length / BYTES_PER_SAMPLE;
    // Where this frame *should* begin on the clip's timeline.
    const expectedStart = Math.round((arrivedMs - this.startMs) * SAMPLES_PER_MS) - frameSamples;
    const gap = expectedStart - this.samples;
    if (gap > this.toleranceSamples) {
      this.chunks.push(Buffer.alloc(gap * BYTES_PER_SAMPLE));
      this.samples += gap;
    }
    this.chunks.push(monoPcm);
    this.samples += frameSamples;
  }

  get durationMs() {
    return this.samples / SAMPLES_PER_MS;
  }

  get empty() {
    return this.samples === 0;
  }

  pcm() {
    return Buffer.concat(this.chunks);
  }
}
