// All configuration comes from the environment, so the same image runs
// anywhere. Secrets (the bot token) belong in an env file, never in Nix.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function float(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set');

  return {
    token,
    // When set, slash commands are registered to this guild only (instant).
    // When unset they are registered globally (can take a while to appear).
    guildId: str('DISCORD_GUILD_ID', null),
    // Where session folders are written.
    dataDir: str('SCRIBBYDASCRIBE_DATA_DIR', '/data/sessions'),
    // Also keep text messages posted anywhere in the server while recording.
    // Needs the Message Content intent switched on in the developer portal.
    recordChat: bool('SCRIBBYDASCRIBE_RECORD_CHAT', true),
    // Where /scribe export saves files too big to upload to Discord.
    exportDir: str('SCRIBBYDASCRIBE_EXPORT_DIR', '/data/exports'),
    // A speaker's clip ends after this much silence (ms).
    silenceMs: int('SCRIBBYDASCRIBE_SILENCE_MS', 800),
    // Clips shorter than this are kept as audio but not transcribed (ms).
    // Whisper tends to invent words on tiny, near-empty clips.
    minClipMs: int('SCRIBBYDASCRIBE_MIN_CLIP_MS', 400),
    // A single clip is cut after this long, even mid-sentence (ms), so a
    // long monologue still transcribes as the call goes.
    maxClipMs: int('SCRIBBYDASCRIBE_MAX_CLIP_MS', 30_000),
    // Leave and finish the session after the bot has been alone this long (ms).
    aloneTimeoutMs: int('SCRIBBYDASCRIBE_ALONE_TIMEOUT_MS', 120_000),
    // When the bot is stopped (an update, a reboot), keep recordings where
    // they are and carry on with them when it starts again, instead of
    // finishing them.
    resumeAfterRestart: bool('SCRIBBYDASCRIBE_RESUME_AFTER_RESTART', true),
    // ...unless it is down longer than this (ms): then each suspended
    // recording is finished as it stood when the bot went down.
    resumeWindowMs: int('SCRIBBYDASCRIBE_RESUME_WINDOW_MS', 15 * 60_000),
    // Transcription worker.
    python: str('SCRIBBYDASCRIBE_PYTHON', 'python3'),
    workerScript: str('SCRIBBYDASCRIBE_WORKER', new URL('../worker/transcribe.py', import.meta.url).pathname),
    whisperModel: str('WHISPER_MODEL', 'small'),
    whisperDevice: str('WHISPER_DEVICE', 'cpu'),
    whisperCompute: str('WHISPER_COMPUTE_TYPE', 'int8'),
    whisperLanguage: str('WHISPER_LANGUAGE', 'en'),
    whisperThreads: int('WHISPER_THREADS', 0),
    // ffmpeg is used to encode the per-speaker aligned tracks.
    ffmpeg: str('SCRIBBYDASCRIBE_FFMPEG', 'ffmpeg'),
    // /scribe transpose (party mode): how close (cosine similarity, 0-1) a
    // clip's voice embedding must be to an existing party member's cluster to
    // be called theirs, rather than starting a new cluster. Lower catches
    // more of the same person's lines but blurs similar-sounding voices
    // together; higher keeps voices apart but splinters one person into
    // several. Best-effort either way.
    voiceSplitThreshold: float('SCRIBBYDASCRIBE_VOICE_SPLIT_THRESHOLD', 0.75),
  };
}
