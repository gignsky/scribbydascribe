# CLAUDE.md: scrivener

A Discord bot that records voice calls and writes per-speaker, timestamped transcripts. It ships as an OCI image that runs on the fleet host **spacedock**. The `.dotfiles` repo consumes it as a flake input, the same way it consumes avecmoi.

## Layout

| Path | Role |
|---|---|
| `src/index.js` | discord.js client, the `/scribe` commands (start, pause, resume, stop, status, export, help), auto-stop and graceful shutdown |
| `src/status.js` | the help text and the `/scribe status` wording, as pure functions of a session snapshot |
| `src/export.js` | lists finished sessions and renders the combined JSONL/CSV export |
| `src/session.js` | one recording: voice receive, a clip per speaker's turn, pause/resume, text chat, the transcription queue and its progress, final outputs |
| `src/audio.js` | PCM helpers and `ClipBuilder` (keeps clips true to the wall clock) |
| `src/transcriber.js` | drives the Python worker over JSON lines on stdin/stdout |
| `src/output.js` | transcript md/srt/json and ffmpeg-built aligned speaker tracks |
| `worker/transcribe.py` | long-lived faster-whisper process |
| `nix/package.nix`, `nix/image.nix`, `flake.nix` | the program, the image (`packages.default`) and the dev shell |
| `deploy/scrivener.nix` | reference copy of the spacedock service payload; the live copy is in `.dotfiles/containers/services/` |

## Commands

```
nix develop -c npm ci
nix develop -c npm test          # 23 tests, incl. an Opus -> Whisper speech round trip
nix build .#scrivener            # the program; runs the unit tests in checkPhase
nix build                        # the OCI image tarball
```

After changing `package-lock.json`, recompute `npmDepsHash` in `nix/package.nix`: set it to `lib.fakeHash`, build, and copy in the hash from the error.

## Branches

`master` is the main branch: `.dotfiles` pins the flake input to `github:gignsky/scribbydascribe/master`, so what lands on `master` is what spacedock gets on its next `nix flake update scrivener`. Work on a feature branch and merge into `master` when it is tested.

## Rules

- `@discordjs/voice` must stay ≥ 0.19.2 and keep `@snazzah/davey`, or audio receive breaks under Discord's DAVE end-to-end encryption.
- `opusscript` is pinned to `^0.0.8` to satisfy prism-media's peer range. Keep native `@discordjs/opus` out, because it complicates the Nix build.
- Recording chat needs the privileged Message Content intent. If Discord refuses it, `index.js` falls back to voice-only rather than going offline; keep that fallback.
- Never commit tokens. The bot token only ever lives in sops (`scrivener-env` in nix-secrets).
- Video capture is out of scope for the bot: Discord's bot API can't receive video, and selfbots break Discord's terms.
