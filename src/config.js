// All configuration comes from the environment, so the same image runs
// anywhere. Secrets (the bot token) belong in an env file, never in Nix.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
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
    dataDir: str('SCRIVENER_DATA_DIR', '/data/sessions'),
    // A speaker's clip ends after this much silence (ms).
    silenceMs: int('SCRIVENER_SILENCE_MS', 800),
    // Clips shorter than this are kept as audio but not transcribed (ms).
    // Whisper tends to invent words on tiny, near-empty clips.
    minClipMs: int('SCRIVENER_MIN_CLIP_MS', 400),
    // A single clip is cut after this long, even mid-sentence (ms), so a
    // long monologue still transcribes as the call goes.
    maxClipMs: int('SCRIVENER_MAX_CLIP_MS', 30_000),
    // Leave and finish the session after the bot has been alone this long (ms).
    aloneTimeoutMs: int('SCRIVENER_ALONE_TIMEOUT_MS', 120_000),
    // Transcription worker.
    python: str('SCRIVENER_PYTHON', 'python3'),
    workerScript: str('SCRIVENER_WORKER', new URL('../worker/transcribe.py', import.meta.url).pathname),
    whisperModel: str('WHISPER_MODEL', 'small'),
    whisperDevice: str('WHISPER_DEVICE', 'cpu'),
    whisperCompute: str('WHISPER_COMPUTE_TYPE', 'int8'),
    whisperLanguage: str('WHISPER_LANGUAGE', 'en'),
    whisperThreads: int('WHISPER_THREADS', 0),
    // ffmpeg is used to encode the per-speaker aligned tracks.
    ffmpeg: str('SCRIVENER_FFMPEG', 'ffmpeg'),
  };
}
