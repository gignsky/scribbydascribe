// One recording of one voice channel: join, capture each speaker's audio as
// separate clips, transcribe as it goes, and write the results when stopped.

import { mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
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

// What a session leaves in its folder when the bot stops mid-recording, so
// the next start can pick it up.
export const RESUME_FILE = 'resume.json';

/** Thrown out of a stop that was cut short by a restart; nothing is lost. */
export class Suspended extends Error {
  constructor() {
    super('suspended for a restart');
    this.name = 'Suspended';
  }
}

/** Join a voice channel and wait until the connection is usable. */
async function connectVoice(voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // must hear to record
    selfMute: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    throw new Error(`could not connect to voice: ${err.message}`);
  }
  return connection;
}

/** A JSON-lines file, skipping a line cut short by a crash. */
async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

/** Every session under dataDir that was suspended for a restart: [{ file, state }]. */
export async function findSuspended(dataDir) {
  let names;
  try {
    names = await readdir(dataDir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.sort()) {
    const file = join(dataDir, name, RESUME_FILE);
    try {
      found.push({ file, state: JSON.parse(await readFile(file, 'utf8')) });
    } catch {
      /* not suspended, or unreadable */
    }
  }
  return found;
}

export class RecordingSession {
  /** @type {import('@discordjs/voice').VoiceConnection | null} */
  connection = null;
  startedAt = 0;
  stoppedAt = 0;
  stopping = null;
  pausedAt = 0; // wall-clock ms the current pause began, 0 when not paused
  suspendedAt = 0; // wall-clock ms the bot went down, while suspended or just restored

  #cfg;
  #transcriber;
  #active = new Map(); // userId -> { opus, decoder, builder }
  #names = new Map(); // userId -> display name
  #clips = []; // { speakerId, offsetMs, durationMs, file }
  #entries = []; // transcribed clips
  #jobs = new Set(); // in-flight transcriptions
  #failed = 0;
  #pauses = []; // { startMs, endMs, by } on the session timeline
  #phase = 'recording'; // after stop: transcribing -> writing -> tracks -> done
  #clipsDone = 0; // clips whose job has settled (written, transcribed or failed)
  #audioMs = 0; // audio sent for transcription
  #audioDoneMs = 0; // ...of which finished
  #drain = null; // { atMs, audioDoneMs } when stopped, to estimate time left
  #chat = []; // text messages posted in the server while recording
  #chatWrites = Promise.resolve(); // keeps chat.jsonl appends in order
  #done = new Set(); // clip files whose job has settled, to requeue the rest after a restart
  #writes = new Set(); // clip files still being written to disk
  #suspended = false; // shutting down for a restart: unfinished work is kept, not failed
  #connect;

  /**
   * @param {object} o
   * @param {import('discord.js').VoiceBasedChannel} o.voiceChannel
   * @param {import('discord.js').TextBasedChannel} o.textChannel
   * @param {import('discord.js').User} o.startedBy
   * @param {(reason: string) => unknown} [o.onLost] called if the voice connection drops for good
   * @param {(channel: import('discord.js').VoiceBasedChannel) => Promise<import('@discordjs/voice').VoiceConnection>} [o.connect] for tests
   */
  constructor({ cfg, transcriber, voiceChannel, textChannel, startedBy, onLost = (reason) => this.stop(reason), connect = connectVoice }) {
    this.onLost = onLost;
    this.#connect = connect;
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
      pausedMs: this.#pausedMs(),
      pauses: this.#pauses.map((p) => ({ ...p })),
    };
  }

  async start() {
    const now = new Date();
    this.dir = join(this.#cfg.dataDir, `${stamp(now)}_${this.voiceChannel.name.replace(/[^\w-]+/g, '_')}`);
    await mkdir(join(this.dir, 'clips'), { recursive: true });
    await mkdir(join(this.dir, 'tracks'), { recursive: true });
    this.connection = await this.#connect(this.voiceChannel);

    // The sync anchor: every timestamp in the outputs is an offset from here.
    this.startedAt = Date.now();
    await this.#writeMeta();
    this.#watchConnection();
  }

  #watchConnection() {
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved between channels or a brief network blip: wait to see if it recovers.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopping && !this.#suspended) this.onLost('disconnected from voice');
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
    if (this.stopping || this.pausedAt || this.#active.has(userId)) return;
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
    if (durationMs >= this.#cfg.minClipMs) this.#audioMs += durationMs;

    const written = writeFile(join(this.dir, file), toWav(builder.pcm()));
    const forget = () => this.#writes.delete(written);
    this.#writes.add(written);
    written.then(forget, forget);
    this.#transcribeClip(clip, written);
  }

  /** Transcribe one clip once its file is on disk. */
  #transcribeClip(clip, written = Promise.resolve()) {
    const { speakerId, offsetMs, durationMs, file } = clip;
    const transcribe = durationMs >= this.#cfg.minClipMs;
    const job = (async () => {
      let settled = true;
      try {
        await written;
        if (!transcribe) return;
        const speaker = await this.#name(speakerId);
        const res = await this.#transcriber.transcribe(join(this.dir, file), durationMs);
        if (!res.segments.length) return;
        const entry = { offsetMs, speakerId, speaker, segments: res.segments, file };
        this.#entries.push(entry);
        // Written as we go, so a crash still leaves a usable record.
        await appendFile(join(this.dir, 'events.jsonl'), JSON.stringify(entry) + '\n');
      } catch (err) {
        if (this.#suspended) {
          // The worker was stopped for a restart; this clip goes again after.
          settled = false;
          return;
        }
        this.#failed++;
        console.error(`[session] clip ${file} failed: ${err.message}`);
      } finally {
        if (settled) {
          this.#done.add(file);
          this.#clipsDone++;
          if (transcribe) this.#audioDoneMs += durationMs;
        }
      }
    })();
    this.#jobs.add(job);
    job.finally(() => this.#jobs.delete(job));
  }

  async #writeMeta(extra = {}) {
    const speakers = Object.fromEntries(this.#names);
    await writeFile(join(this.dir, 'session.json'), JSON.stringify({ ...this.meta, speakers, ...extra }, null, 2) + '\n');
  }

  /** Where the session is now: recording, paused, or one of the finishing steps. */
  get phase() {
    if (this.stopping) return this.#phase;
    return this.pausedAt ? 'paused' : 'recording';
  }

  /** A point-in-time view for `/scribe status`. See status.js. */
  get snapshot() {
    const pause = this.#pauses.at(-1);
    return {
      channelName: this.voiceChannel.name,
      phase: this.phase,
      durationMs: this.meta.durationMs,
      pausedMs: this.#pausedMs(),
      pausedBy: this.pausedAt ? pause?.by : null,
      pausedForMs: this.pausedAt ? Date.now() - this.pausedAt : 0,
      reason: this.reason ?? null,
      speakers: this.#names.size,
      lines: this.#entries.reduce((n, e) => n + e.segments.length, 0),
      chat: this.#chat.length,
      clips: this.#clips.length,
      clipsDone: this.#clipsDone,
      audioMs: this.#audioMs,
      audioDoneMs: this.#audioDoneMs,
      drain: this.#drain && { ...this.#drain },
      rate: this.#transcriber.rate ?? null,
      modelLoading: this.#transcriber.ready === false,
    };
  }

  /**
   * Keep a text message posted anywhere in the server during the recording,
   * so it lines up with the speech. Like speech, nothing is kept while paused.
   * @param {import('discord.js').Message} msg
   */
  recordMessage(msg) {
    if (this.stopping || this.pausedAt || !this.startedAt || msg.createdTimestamp < this.startedAt) return false;
    const text = msg.cleanContent;
    const attachments = [...msg.attachments.values()].map((a) => ({ name: a.name, url: a.url }));
    if (!text && !attachments.length) return false; // stickers, embeds-only, etc.
    const entry = {
      atMs: msg.createdTimestamp - this.startedAt,
      messageId: msg.id,
      channelId: msg.channelId,
      channel: msg.channel?.name ?? msg.channelId,
      authorId: msg.author.id,
      author: msg.member?.displayName ?? msg.author.displayName ?? msg.author.username,
      bot: msg.author.bot,
      text,
      attachments,
    };
    this.#addChat(entry);
    return true;
  }

  /**
   * A /roll made in this server while recording. The bot's own messages are
   * never recorded, so the roll goes in here, credited to whoever rolled.
   * It needs no Message Content intent, so it is kept even when chat is not.
   */
  recordRoll({ at = Date.now(), messageId = null, channel, user, member, text }) {
    if (this.stopping || this.pausedAt || !this.startedAt || at < this.startedAt) return false;
    this.#addChat({
      atMs: at - this.startedAt,
      messageId,
      channelId: channel?.id ?? null,
      channel: channel?.name ?? channel?.id ?? null,
      authorId: user.id,
      author: member?.displayName ?? user.displayName ?? user.username,
      bot: false,
      text,
      attachments: [],
    });
    return true;
  }

  #addChat(entry) {
    this.#chat.push(entry);
    // Written as we go, like events.jsonl, so a crash still leaves a record.
    this.#chatWrites = this.#chatWrites
      .then(() => appendFile(join(this.dir, 'chat.jsonl'), JSON.stringify(entry) + '\n'))
      .catch((err) => console.error('[session] writing chat.jsonl failed:', err.message));
  }

  #pausedMs(now = this.stoppedAt || Date.now()) {
    const nowOffset = now - this.startedAt;
    return this.#pauses.reduce((n, p) => n + ((p.endMs ?? nowOffset) - p.startMs), 0);
  }

  /** End every open clip at this moment and drop the audio subscriptions. */
  #flushActive() {
    for (const rec of [...this.#active.values()]) {
      rec.finish();
      rec.opus.destroy();
      rec.decoder.destroy();
    }
  }

  /**
   * Stop capturing audio but stay in the call. The session timeline keeps
   * running, so the paused stretch is silence in the tracks and a gap in the
   * transcript, and later timestamps still line up with the wall clock.
   * @returns {boolean} false if already paused or stopping
   */
  pause(by) {
    if (this.stopping || this.pausedAt) return false;
    this.pausedAt = Date.now();
    this.#pauses.push({ startMs: this.pausedAt - this.startedAt, endMs: null, by });
    this.#flushActive();
    this.#writeMeta().catch((err) => console.error('[session] writing session.json failed:', err.message));
    return true;
  }

  /** @returns {boolean} false if not paused or stopping */
  resume() {
    if (this.stopping || !this.pausedAt) return false;
    this.#closePause(Date.now());
    // Anyone already talking won't raise a fresh 'start' until they next go
    // quiet, so pick them up now.
    for (const userId of this.connection.receiver.speaking.users.keys()) this.#listen(userId);
    this.#writeMeta().catch((err) => console.error('[session] writing session.json failed:', err.message));
    return true;
  }

  #closePause(now) {
    if (!this.pausedAt) return;
    this.#pauses.at(-1).endMs = now - this.startedAt;
    this.pausedAt = 0;
  }

  /** Idempotent: every caller gets the same finishing promise. */
  stop(reason = 'stopped') {
    this.stopping ??= this.#finish(reason);
    return this.stopping;
  }

  async #finish(reason) {
    // Already set when a session restored after a restart is finishing.
    this.stoppedAt ||= Date.now();
    this.reason = reason;
    this.#closePause(this.stoppedAt);
    this.#phase = 'transcribing';
    // Flush every open clip, then hang up.
    this.#flushActive();
    this.connection?.destroy();

    this.#drain = { atMs: Date.now(), audioDoneMs: this.#audioDoneMs };
    while (this.#jobs.size) await Promise.allSettled([...this.#jobs]);
    if (this.#suspended) throw new Suspended();

    this.#phase = 'writing';
    await this.#chatWrites;
    const meta = this.meta;
    const lines = buildLines(this.#entries);
    const chat = [...this.#chat].sort((a, b) => a.atMs - b.atMs);
    const md = toMarkdown(meta, lines, chat);
    await writeFile(join(this.dir, 'transcript.md'), md);
    await writeFile(join(this.dir, 'transcript.srt'), toSrt(lines));
    await writeFile(join(this.dir, 'transcript.json'), toJson(meta, lines, this.#clips, chat));

    this.#phase = 'tracks';
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
    this.#phase = 'done';

    return { dir: this.dir, meta, lines, chat, reason, failed: this.#failed, tracksError };
  }

  /**
   * Put the session down for a restart: close any open clips, get them on
   * disk and leave the call. Recording is paused until the restore, so the
   * downtime is a marked gap rather than lost time. Call {@link settled}
   * once the worker is stopped, then {@link saveState}.
   * @returns {Promise<boolean>} false once past transcribing, when finishing is quicker
   */
  async suspend() {
    if (!['recording', 'paused', 'transcribing'].includes(this.phase)) return false;
    this.#suspended = true;
    this.suspendedAt = Date.now();
    if (!this.stopping) {
      if (!this.pausedAt) {
        this.pausedAt = this.suspendedAt;
        this.#pauses.push({ startMs: this.suspendedAt - this.startedAt, endMs: null, by: null, restart: true });
      }
      this.#flushActive();
      this.connection?.destroy();
    }
    await Promise.allSettled([...this.#writes]);
    return true;
  }

  /** Resolves when no transcription is in flight and chat is on disk. */
  async settled() {
    while (this.#jobs.size) await Promise.allSettled([...this.#jobs]);
    await this.#chatWrites;
  }

  /** Everything a restore needs that is not already in events.jsonl and chat.jsonl. */
  get state() {
    return {
      version: 1,
      guildId: this.guild.id,
      voiceChannelId: this.voiceChannel.id,
      textChannelId: this.textChannel?.id ?? null,
      startedById: this.startedBy.id ?? null,
      startedByTag: this.startedBy.tag,
      dir: this.dir,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      stopping: Boolean(this.stopping),
      reason: this.reason ?? null,
      suspendedAt: this.suspendedAt,
      pausedAt: this.pausedAt,
      pauses: this.#pauses.map((p) => ({ ...p })),
      names: Object.fromEntries(this.#names),
      clips: this.#clips,
      done: [...this.#done],
      failed: this.#failed,
    };
  }

  async saveState() {
    await writeFile(join(this.dir, RESUME_FILE), JSON.stringify(this.state, null, 2) + '\n');
  }

  /**
   * Rebuild a suspended session from its folder. The resume file is removed
   * once read, so a session that cannot be restored is not retried forever.
   * Call {@link requeue}, then {@link rejoin} or {@link endAtSuspend}.
   */
  static async restore({ state, ...o }) {
    const s = new RecordingSession(o);
    s.dir = state.dir;
    s.startedAt = state.startedAt;
    s.stoppedAt = state.stoppedAt || 0;
    s.reason = state.reason ?? undefined;
    s.suspendedAt = state.suspendedAt;
    s.pausedAt = state.pausedAt || 0;
    s.#pauses = state.pauses.map((p) => ({ ...p }));
    s.#names = new Map(Object.entries(state.names ?? {}));
    s.#clips = state.clips.map((c) => ({ ...c }));
    s.#failed = state.failed ?? 0;

    // A clip can finish between the state being taken and the process
    // ending, so events.jsonl has the last word on what was transcribed.
    const byFile = new Map((await readJsonl(join(s.dir, 'events.jsonl'))).map((e) => [e.file, e]));
    s.#entries = [...byFile.values()];
    s.#chat = await readJsonl(join(s.dir, 'chat.jsonl'));
    s.#done = new Set([...state.done, ...byFile.keys()]);
    for (const c of s.#clips) {
      const transcribe = c.durationMs >= s.#cfg.minClipMs;
      if (transcribe) s.#audioMs += c.durationMs;
      if (!s.#done.has(c.file)) continue;
      s.#clipsDone++;
      if (transcribe) s.#audioDoneMs += c.durationMs;
    }
    await rm(join(s.dir, RESUME_FILE), { force: true });
    return s;
  }

  /** Whether the session had been stopped, and was finishing, when it was suspended. */
  get wasStopping() {
    return this.stoppedAt > 0;
  }

  /** Transcribe the clips the restart interrupted or never reached. */
  requeue() {
    for (const clip of this.#clips) if (!this.#done.has(clip.file)) this.#transcribeClip(clip);
  }

  /** Back into the call after a restart, recording again unless someone had paused it. */
  async rejoin() {
    this.connection = await this.#connect(this.voiceChannel);
    this.#watchConnection();
    const last = this.#pauses.at(-1);
    if (last?.restart && last.endMs == null) this.#closePause(Date.now());
    if (!this.pausedAt) for (const userId of this.connection.receiver.speaking.users.keys()) this.#listen(userId);
    this.#writeMeta().catch((err) => console.error('[session] writing session.json failed:', err.message));
  }

  /** Not coming back: the session ends where the restart began. Then stop() it. */
  endAtSuspend() {
    const last = this.#pauses.at(-1);
    if (last?.restart && last.endMs == null) {
      this.#pauses.pop();
      this.pausedAt = 0;
    }
    this.#closePause(this.suspendedAt);
    this.stoppedAt = this.suspendedAt;
  }
}
