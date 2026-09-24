// One recording of one voice channel: join, capture each speaker's audio as
// separate clips, transcribe as it goes, and write the results when stopped.

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { ClipBuilder, stereoToMono, toWav } from './audio.js';
import { buildLines, buildTracks, toJson, toMarkdown, toSrt } from './output.js';

function stamp(d) {
  return d.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
}

export class RecordingSession {
  /** @type {import('@discordjs/voice').VoiceConnection | null} */
  connection = null;
  startedAt = 0;
  stoppedAt = 0;
  stopping = null;

  #cfg;
  #transcriber;
  #active = new Map(); // userId -> { opus, decoder, builder }
  #names = new Map(); // userId -> display name
  #clips = []; // { speakerId, offsetMs, durationMs, file }
  #entries = []; // transcribed clips
  #jobs = new Set(); // in-flight transcriptions
  #failed = 0;

  /**
   * @param {object} o
   * @param {import('discord.js').VoiceBasedChannel} o.voiceChannel
   * @param {import('discord.js').TextBasedChannel} o.textChannel
   * @param {import('discord.js').User} o.startedBy
   * @param {(reason: string) => unknown} [o.onLost] called if the voice connection drops for good
   */
  constructor({ cfg, transcriber, voiceChannel, textChannel, startedBy, onLost = (reason) => this.stop(reason) }) {
    this.onLost = onLost;
    this.#cfg = cfg;
    this.#transcriber = transcriber;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.startedBy = startedBy;
    this.guild = voiceChannel.guild;
  }

  get meta() {
    return {
      guildId: this.guild.id,
      guildName: this.guild.name,
      channelId: this.voiceChannel.id,
      channelName: this.voiceChannel.name,
      startedBy: this.startedBy.tag,
      startedAt: new Date(this.startedAt).toISOString(),
      startedAtMs: this.startedAt,
      durationMs: (this.stoppedAt || Date.now()) - this.startedAt,
    };
  }

  async start() {
    const now = new Date();
    this.dir = join(this.#cfg.dataDir, `${stamp(now)}_${this.voiceChannel.name.replace(/[^\w-]+/g, '_')}`);
    await mkdir(join(this.dir, 'clips'), { recursive: true });
    await mkdir(join(this.dir, 'tracks'), { recursive: true });

    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to record
      selfMute: true,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      this.connection.destroy();
      throw new Error(`could not connect to voice: ${err.message}`);
    }

    // The sync anchor: every timestamp in the outputs is an offset from here.
    this.startedAt = Date.now();
    await this.#writeMeta();

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved between channels or a brief network blip: wait to see if it recovers.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopping) this.onLost('disconnected from voice');
      }
    });
    this.connection.on('error', (err) => console.error('[voice]', err));

    this.connection.receiver.speaking.on('start', (userId) => this.#listen(userId));
  }

  async #name(userId) {
    if (this.#names.has(userId)) return this.#names.get(userId);
    let name = userId;
    try {
      const m = await this.guild.members.fetch(userId);
      name = m.displayName;
    } catch {
      /* left the server, etc. */
    }
    this.#names.set(userId, name);
    return name;
  }

  #listen(userId) {
    if (this.stopping || this.#active.has(userId)) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return;
    this.#name(userId); // warm the cache

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.#cfg.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const rec = { opus, decoder, builder: null, done: false, finish: null };
    this.#active.set(userId, rec);

    decoder.on('data', (stereo) => {
      if (rec.done) return;
      const now = Date.now();
      rec.builder ??= new ClipBuilder(now - 20);
      rec.builder.push(stereoToMono(stereo), now);
      if (rec.builder.durationMs >= this.#cfg.maxClipMs) {
        // Cut here and carry on seamlessly in a new clip.
        const done = rec.builder;
        rec.builder = new ClipBuilder(done.startMs + done.durationMs);
        this.#finishClip(userId, done);
      }
    });

    const finish = () => {
      if (rec.done) return;
      rec.done = true;
      if (this.#active.get(userId) === rec) this.#active.delete(userId);
      if (rec.builder) this.#finishClip(userId, rec.builder);
      rec.builder = null;
    };
    decoder.on('end', finish);
    decoder.on('close', finish);
    decoder.on('error', (err) => {
      console.warn(`[voice] decode error for ${userId}: ${err.message}`);
      finish();
    });
    rec.finish = finish;
    opus.on('error', (err) => console.warn(`[voice] stream error for ${userId}: ${err.message}`));
    opus.pipe(decoder);
  }

  #finishClip(userId, builder) {
    if (builder.empty) return;
    const offsetMs = Math.max(0, Math.round(builder.startMs - this.startedAt));
    const durationMs = Math.round(builder.durationMs);
    const file = join('clips', `${String(offsetMs).padStart(9, '0')}_${userId}.wav`);
    const clip = { speakerId: userId, offsetMs, durationMs, file };
    this.#clips.push(clip);

    const job = (async () => {
      try {
        await writeFile(join(this.dir, file), toWav(builder.pcm()));
        if (durationMs < this.#cfg.minClipMs) return;
        const speaker = await this.#name(userId);
        const res = await this.#transcriber.transcribe(join(this.dir, file));
        if (!res.segments.length) return;
        const entry = { offsetMs, speakerId: userId, speaker, segments: res.segments, file };
        this.#entries.push(entry);
        // Written as we go, so a crash still leaves a usable record.
        await appendFile(join(this.dir, 'events.jsonl'), JSON.stringify(entry) + '\n');
      } catch (err) {
        this.#failed++;
        console.error(`[session] clip ${file} failed: ${err.message}`);
      }
    })();
    this.#jobs.add(job);
    job.finally(() => this.#jobs.delete(job));
  }

  async #writeMeta(extra = {}) {
    const speakers = Object.fromEntries(this.#names);
    await writeFile(join(this.dir, 'session.json'), JSON.stringify({ ...this.meta, speakers, ...extra }, null, 2) + '\n');
  }

  get stats() {
    return {
      durationMs: this.meta.durationMs,
      speakers: this.#names.size,
      clips: this.#clips.length,
      lines: this.#entries.reduce((n, e) => n + e.segments.length, 0),
      pending: this.#jobs.size,
    };
  }

  /** Idempotent: every caller gets the same finishing promise. */
  stop(reason = 'stopped') {
    this.stopping ??= this.#finish(reason);
    return this.stopping;
  }

  async #finish(reason) {
    this.stoppedAt = Date.now();
    // Flush every open clip, then hang up.
    for (const rec of [...this.#active.values()]) {
      rec.finish();
      rec.opus.destroy();
      rec.decoder.destroy();
    }
    this.connection?.destroy();

    while (this.#jobs.size) await Promise.allSettled([...this.#jobs]);

    const meta = this.meta;
    const lines = buildLines(this.#entries);
    const md = toMarkdown(meta, lines);
    await writeFile(join(this.dir, 'transcript.md'), md);
    await writeFile(join(this.dir, 'transcript.srt'), toSrt(lines));
    await writeFile(join(this.dir, 'transcript.json'), toJson(meta, lines, this.#clips));

    let tracksError = null;
    try {
      await buildTracks({
        ffmpeg: this.#cfg.ffmpeg,
        sessionDir: this.dir,
        clips: this.#clips,
        speakers: this.#names,
        durationMs: meta.durationMs,
      });
    } catch (err) {
      tracksError = err.message;
      console.error('[session] building tracks failed:', err);
    }
    await this.#writeMeta({ stoppedAt: new Date(this.stoppedAt).toISOString(), reason, failedClips: this.#failed, tracksError });

    return { dir: this.dir, meta, lines, reason, failed: this.#failed, tracksError };
  }
}
