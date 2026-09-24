# scrivener

A Discord bot that joins a voice call, records each speaker separately, and writes a timestamped transcript labelled by speaker. It runs on spacedock as a podman container.

Discord sends a bot each person's audio as a separate stream, so speakers never need to be guessed: every line is labelled with the Discord member who said it.

## Commands

| Command | What it does |
|---|---|
| `/scribe start` | Joins your current voice channel and starts recording. It announces the recording in the channel where you ran the command and in the voice channel's chat. |
| `/scribe stop` | Stops recording, finishes transcribing, and posts `transcript.md` and `transcript.srt` in the channel where recording started. |
| `/scribe status` | Shows how long it has been recording, the speakers so far, the line count, and the transcription backlog. Only you can see the reply. |

The bot also stops by itself two minutes after the last person leaves, and when the container is stopped. In every case it writes the files and posts the transcript before it exits.

## What a session leaves behind

`/var/lib/scrivener/sessions/2026-09-24T20-00-00_Council/`

| File | Contents |
|---|---|
| `transcript.md` | A readable transcript, e.g. `**[00:01:12] Lord Gig:** …`. A speaker's lines that follow closely on each other are joined into one paragraph. |
| `transcript.srt` | Subtitles, one cue per line. Load this against a video to check the sync. |
| `transcript.json` | Every line with start and end in ms, speaker ID and name, plus the list of clips. |
| `events.jsonl` | Transcribed clips, appended as the call goes, so a crash still leaves a record. |
| `session.json` | Metadata. `startedAtMs` is the sync anchor: every timestamp is an offset from it. |
| `tracks/<name>.ogg` | One track per speaker. Every track is exactly as long as the session and is silent while that person isn't talking. |
| `tracks/mix.ogg` | All speakers mixed together. |
| `clips/*.wav` | The raw clips, one per speaking turn. |

Because every track starts at the same moment as the transcript, lining up video recorded later (see the roadmap) only needs one offset.

## Setting up the Discord bot (one time)

1. Go to <https://discord.com/developers/applications>, choose **New Application**, open **Bot**, and choose **Reset Token**. Copy the token.
2. No privileged intents are needed.
3. Open **OAuth2 → URL Generator**. Select the scopes `bot` and `applications.commands`, and the permissions View Channels, Connect, Send Messages and Attach Files. Open the URL it generates and invite the bot to your server.
4. Optional: to control who may record, use Server Settings → Integrations → scrivener.

## Deploying on spacedock

1. Push this repo to `github:gignsky/scribbydascribe`.
2. Add the secret with `just sops`, as a key `scrivener-env` whose value is an env file:
   ```
   DISCORD_TOKEN=...
   DISCORD_GUILD_ID=...   # optional; registers the slash commands instantly in that server
   ```
3. In `.dotfiles/flake.nix`, add the input:
   ```nix
   scrivener = {
     url = "github:gignsky/scribbydascribe";
     inputs.nixpkgs.follows = "nixpkgs";
   };
   ```
4. Copy `deploy/scrivener.nix` to `containers/services/scrivener.nix` and add `./scrivener.nix` to the imports in `containers/services/default.nix`.
5. Run `just rebuild` on spacedock, then `journalctl -u podman-scrivener -f`. On first start it downloads the Whisper model (about 500 MB for `small`) into `/var/lib/scrivener/models`.

## Configuration

These are all environment variables. The defaults suit spacedock.

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_MODEL` | `small` | Whisper model size: `base`, `small`, `medium` or `large-v3`. Larger models are more accurate and slower on the CPU. |
| `WHISPER_LANGUAGE` | `en` | Language of the speech. Leave it empty to auto-detect per clip. |
| `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `cpu` / `int8` | The Polaris GPU has no CUDA, so transcription runs on the CPU. |
| `SCRIVENER_SILENCE_MS` | `800` | Silence that ends a speaker's clip. |
| `SCRIVENER_MAX_CLIP_MS` | `30000` | Long speeches are split at this length so they transcribe while the call is still going. |
| `SCRIVENER_MIN_CLIP_MS` | `400` | Clips shorter than this are kept as audio but not transcribed, because Whisper invents words on coughs and clicks. |
| `SCRIVENER_ALONE_TIMEOUT_MS` | `120000` | How long the bot stays alone in the channel before it stops. |

## Development

```sh
nix develop          # node 22, python + faster-whisper, ffmpeg, espeak-ng
npm ci
npm test             # unit tests + a speech round trip through Opus and Whisper
DISCORD_TOKEN=... npm start
nix build            # the OCI image  (nix build .#scrivener for just the program)
```

The round-trip test synthesises two voices with espeak-ng and encodes them to Opus the way a Discord client does. It then runs them through the bot's decoder, clip builder, Whisper worker and transcript writer, and checks that each voice's words land under the right speaker at the right time.

## Limits

- **No video.** Discord's bot API cannot receive cameras or Go Live streams. The only tools that can are selfbots, which break Discord's terms of service.
- **Encryption.** Discord has end-to-end encrypted all calls (DAVE) since 2026. Receiving audio needs `@discordjs/voice` ≥ 0.19.2 with `@snazzah/davey`, and both are pinned here. If Discord changes the protocol, update those two packages first.
- **Consent.** Recording is announced when it starts. Tell anyone who joins later yourself.

## Roadmap

- Video sync: a capture machine records the Discord client window with OBS, and a small helper reads `session.json` to trim or offset the video to `startedAtMs`.
