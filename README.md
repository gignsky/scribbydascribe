# scribbydascribe

A Discord bot that joins a voice call, records each speaker separately, and writes a timestamped transcript labelled by speaker. It runs on spacedock as a podman container.

Discord sends a bot each person's audio as a separate stream, so speakers never need to be guessed: every line is labelled with the Discord member who said it.

## Commands

| Command | What it does |
|---|---|
| `/scribe start` | Joins your current voice channel and starts recording. It announces the recording in the channel where you ran the command and in the voice channel's chat. |
| `/scribe pause` | Stops capturing audio but stays in the call. The pause is announced like the start is. Nothing said while paused is saved. |
| `/scribe resume` | Starts capturing again, and says so in the channel. |
| `/scribe stop` | Stops recording, finishes transcribing, and posts `transcript.md` and `transcript.srt` in the channel where recording started. Until then, its reply is a progress message that updates itself every 10 seconds: the step it is on, a progress bar and a rough time left. When the transcript is out it reads ✅. A recording that stops by itself (everyone left, the connection dropped, the container stopped) posts the same progress message in the channel where it was started. |
| `/scribe status` | While recording: how long, the speakers so far, the line count, and whether transcription is keeping up. If it is behind, it shows how much audio is waiting and roughly how long catching up will take. After a stop, until the transcript is posted: which step it is on (transcribing, writing files, building tracks, posting), with a progress bar, clips done and a rough time left. Once it is posted: when the last recording finished and where its transcript went. It also says if the speech model is still loading. Only you can see the reply. |
| `/scribe export [format]` | Offers this server's finished sessions (the 25 most recent) in a menu. Pick any number and you get one file: `jsonl` (default) or `csv`, one row per spoken line from all of them, or `md`, each session laid out like its own `transcript.md`, oldest first. Only you see the menu and the file. |
| `/scribe transpose @user [names]` | Declares that `@user`'s mic carries several party members sharing it, as a comma-separated list of names (`Alice, Bob`), split apart best-effort by voice (see below). Leave `names` blank to stop splitting them. Takes effect in the current recording, if any, and every future one. If that account has spoken in a past recording here, offers a menu to re-split it too. |
| `/scribe help` | Lists the commands. Only you can see the reply. |
| `/roll [dice] [for]` | Rolls dice in the open and shows the working, e.g. `@Ferren 🎲 rolled \`2d20kh1 + 5\` for stealth: [~~4~~, 17] + 5 = **22**`. Takes `NdM` terms joined by `+`/`-`, plain numbers, `d%` for d100, and `khN`/`klN` to keep the highest or lowest N dice (`4d6kh3`, `2d20kh1` for advantage, `2d20kl1` for disadvantage). With no dice given it rolls a `d20`. Up to 100 dice of up to 1000 sides per term. A roll made while the server is being recorded goes into the transcript as a chat line credited to whoever rolled, even when text chat is not being recorded. |

The bot also stops by itself two minutes after the last person leaves. When it stops for that reason, or any other, it writes the files and posts the transcript before it exits. Restarts are the exception (see below).

### Restarts and updates

Stopping the container, for example to update it, does not end a recording. The bot saves where each recording is up to and leaves the call. When it starts again it rejoins the same voice channel and keeps recording into the same session. It says so in the channel both times. The time it was down is a pause in the session, shown in `transcript.md` as `_[00:41:10] Recording paused while the bot restarted for 00:00:52._`, so later timestamps still match the wall clock and the audio tracks stay in sync. A recording someone had paused comes back still paused.

Clips that had not been transcribed yet are picked up again after the restart. So is a recording that had already been stopped and was still working through its backlog. Its progress message says it is on hold, and a new one is posted when the bot is back.

A suspended recording is finished instead of resumed, as it stood when the bot went down, in these cases:
- The bot is down longer than `SCRIBBYDASCRIBE_RESUME_WINDOW_MS` (15 minutes by default).
- Nobody is left in the voice channel when it comes back.
- It cannot rejoin the channel.

Nothing said while the bot was down is recorded, and neither is chat posted then. A crash, as opposed to a stop, does not get the chance to save state. Its session folder keeps the clips and `events.jsonl`, but the recording is not resumed. Set `SCRIBBYDASCRIBE_RESUME_AFTER_RESTART=false` to finish every recording on a stop, as before.

A pause does not stop the session clock. The paused stretch is silence in the audio tracks and a gap in the transcript, marked with a line like `_[00:12:30] Recording paused by Gig for 00:03:10._`, so every later timestamp still matches the wall clock. `session.json` and `transcript.json` list the pauses (`pauses`, `pausedMs`).

### Text chat

While a recording runs, every message posted in any text channel the bot can see is kept, including threads, the voice channel's own chat and other bots' messages (dice rollers, say). Each message gets its offset from the session start, so it lines up with the speech. In `transcript.md` it reads `💬 **[00:14:02] Ferren in #dice:** rolled 17`. Attachments are kept as links. The bot's own messages are skipped, and so is anything posted while the recording is paused. Edits and deletions after a message is posted are not tracked.

This needs Discord's privileged **Message Content** intent (see the setup steps below). The bot checks on startup whether it has been granted it, and if not simply doesn't ask for it: voice is still recorded, and a line in the log says chat is not. Set `SCRIBBYDASCRIBE_RECORD_CHAT=false` to turn chat recording off and stop the check.

### Party mode (`/scribe transpose`)

Sometimes several people are in the room with one Discord account, sharing its mic — a table of players around one laptop, say. `/scribe transpose @user Alice, Bob, Cara` tells the bot to split that account's clips between up to 8 named party members instead of labelling everything with the Discord display name.

Splitting is done by voice, not by anything Discord tells the bot (it only ever sees one audio stream per account): each clip gets a voice embedding from a small speech model, and clips are clustered online into the declared names as the call goes, one cluster per name. It is best-effort, not real diarization — expect some lines under the wrong name, especially early in a call before each voice has said enough, or when voices sound alike. `SCRIBBYDASCRIBE_VOICE_SPLIT_THRESHOLD` (below) tunes how readily it starts a new cluster rather than reusing an existing one.

A party member's lines read `**[00:03:40] Bob (via Gig):**` in `transcript.md`, so the underlying Discord account is never lost, and each gets its own file under `tracks/`. The speech model downloads once, the first time any server uses `/scribe transpose` (see Deploying, below).

Declaring a roster only changes clips from then on; it does not relabel what already happened automatically. To fix up a recording that already finished — whether it predates party mode entirely, or was split under different names — `/scribe transpose` offers a menu of that account's past recordings here, and re-splitting one rewrites its `transcript.md`/`.srt`/`.json`, `events.jsonl` and `tracks/` in place.

The roster itself (who is declared behind which account, per server) lives in `transpose.json` at the top of the sessions directory, not inside any one session's folder.

### Export format

`md` keeps each session's own transcript as-is. For `jsonl`/`csv`, each row is one spoken line, in time order across all the chosen sessions:

| Field | Meaning |
|---|---|
| `session` | The session's folder name |
| `guild`, `channel` | Server and voice channel names |
| `session_started_at` | ISO time the session started |
| `kind` | `speech` or `chat` |
| `text_channel` | For chat, the text channel it was posted in; empty for speech |
| `speaker`, `speaker_id` | Display name and Discord user ID (the author, for chat) |
| `start_ms`, `end_ms` | Offsets from the session start (equal, for chat) |
| `start_at` | ISO time the line was said or posted |
| `text` | What was said or posted; chat attachments are appended as URLs |

JSONL has one JSON object per line. CSV has a header row and uses CRLF line endings, with RFC 4180 quoting. Discord caps a bot's upload at 10 MiB. A larger export is saved on the host in `/var/lib/scribbydascribe/exports/` (`SCRIBBYDASCRIBE_EXPORT_DIR` in the container) instead, and the reply names the file.

## What a session leaves behind

`/var/lib/scribbydascribe/sessions/2026-09-24T20-00-00_Council/`

| File | Contents |
|---|---|
| `transcript.md` | A readable transcript, e.g. `**[00:01:12] Lord Gig:** …`. A speaker's lines that follow closely on each other are joined into one paragraph. |
| `transcript.srt` | Subtitles, one cue per line. Load this against a video to check the sync. |
| `transcript.json` | Every line with start and end in ms, speaker ID and name, plus the list of clips. |
| `events.jsonl` | Transcribed clips, appended as the call goes, so a crash still leaves a record. |
| `chat.jsonl` | Text messages posted anywhere in the server during the recording, appended as they arrive. They are also interleaved into `transcript.md` (marked 💬) and listed under `chat` in `transcript.json`. |
| `resume.json` | Only while the bot is down mid-recording: what it needs to carry on. It is removed when the session is picked up again. |
| `session.json` | Metadata. `startedAtMs` is the sync anchor: every timestamp is an offset from it. |
| `tracks/<name>.ogg` | One track per speaker. Every track is exactly as long as the session and is silent while that person isn't talking. |
| `tracks/mix.ogg` | All speakers mixed together. |
| `clips/*.wav` | The raw clips, one per speaking turn. |

Because every track starts at the same moment as the transcript, lining up video recorded later (see the roadmap) only needs one offset.

## Setting up the Discord bot (one time)

1. Go to <https://discord.com/developers/applications>, choose **New Application**, open **Bot**, and choose **Reset Token**. Copy the token.
2. On the same **Bot** page, under Privileged Gateway Intents, switch on **Message Content Intent**. This lets the bot record text chat alongside the call. It is the only privileged intent needed; without it, voice is still recorded.
3. Open **OAuth2 → URL Generator**. Select the scopes `bot` and `applications.commands`, and the permissions View Channels, Connect, Send Messages and Attach Files. Open the URL it generates and invite the bot to your server. Chat is only recorded from text channels where the bot has View Channels, so hide a channel from the bot's role to keep it out.
4. Optional: to control who may record, use Server Settings → Integrations → scribbydascribe.

## Deploying on spacedock

1. Push to the `master` branch of `github:gignsky/scribbydascribe`. `master` is the release branch that spacedock deploys.
2. Add the secret with `just sops`, as a key `scribbydascribe-env` whose value is an env file:
   ```
   DISCORD_TOKEN=...
   DISCORD_GUILD_ID=...   # optional; registers the slash commands instantly in that server
   ```
3. In `.dotfiles/flake.nix`, add the input:
   ```nix
   scribbydascribe = {
     url = "github:gignsky/scribbydascribe/master";
     inputs.nixpkgs.follows = "nixpkgs";
   };
   ```
4. Copy `deploy/scribbydascribe.nix` to `containers/services/scribbydascribe.nix` and add `./scribbydascribe.nix` to the imports in `containers/services/default.nix`.
5. Run `just rebuild` on spacedock, then `journalctl -u podman-scribbydascribe -f`. On first start it downloads the Whisper model (about 500 MB for `small`) into `/var/lib/scribbydascribe/models`. The `/scribe transpose` speaker-embedding model downloads the same way, the first time any server uses it (a couple hundred MB more).

## Configuration

These are all environment variables. The defaults suit spacedock.

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_MODEL` | `small` | Whisper model size: `base`, `small`, `medium` or `large-v3`. Larger models are more accurate and slower on the CPU. |
| `WHISPER_LANGUAGE` | `en` | Language of the speech. Leave it empty to auto-detect per clip. |
| `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `cpu` / `int8` | The Polaris GPU has no CUDA, so transcription runs on the CPU. |
| `SCRIBBYDASCRIBE_SILENCE_MS` | `800` | Silence that ends a speaker's clip. |
| `SCRIBBYDASCRIBE_MAX_CLIP_MS` | `30000` | Long speeches are split at this length so they transcribe while the call is still going. |
| `SCRIBBYDASCRIBE_MIN_CLIP_MS` | `400` | Clips shorter than this are kept as audio but not transcribed, because Whisper invents words on coughs and clicks. |
| `SCRIBBYDASCRIBE_ALONE_TIMEOUT_MS` | `120000` | How long the bot stays alone in the channel before it stops. |
| `SCRIBBYDASCRIBE_RESUME_AFTER_RESTART` | `true` | On a container stop, suspend recordings and carry on with them when the bot starts again, instead of finishing them. |
| `SCRIBBYDASCRIBE_RESUME_WINDOW_MS` | `900000` | If the bot is down longer than this, suspended recordings are finished as they stood instead of resumed. |
| `SCRIBBYDASCRIBE_RECORD_CHAT` | `true` | Also record text messages posted in the server while recording. Needs the Message Content intent. |
| `SCRIBBYDASCRIBE_EXPORT_DIR` | `/data/exports` | Where an export too big to upload to Discord is saved. On spacedock that is `/var/lib/scribbydascribe/exports`. |
| `SCRIBBYDASCRIBE_VOICE_SPLIT_THRESHOLD` | `0.75` | `/scribe transpose`'s voice-matching cosine similarity (0-1). Lower catches more of the same person's lines but blurs similar voices together; higher keeps voices apart but can splinter one person into several. |

## Development

```sh
nix develop          # node 22, python + faster-whisper, ffmpeg, espeak-ng
npm ci
npm test             # unit tests + a speech round trip through Opus and Whisper
DISCORD_TOKEN=... npm start
nix build            # the OCI image  (nix build .#scribbydascribe for just the program)
```

The round-trip test synthesises two voices with espeak-ng and encodes them to Opus the way a Discord client does. It then runs them through the bot's decoder, clip builder, Whisper worker and transcript writer, and checks that each voice's words land under the right speaker at the right time.

## Limits

- **No video.** Discord's bot API cannot receive cameras or Go Live streams. The only tools that can are selfbots, which break Discord's terms of service.
- **Encryption.** Discord has end-to-end encrypted all calls (DAVE) since 2026. Receiving audio needs `@discordjs/voice` ≥ 0.19.2 with `@snazzah/davey`, and both are pinned here. If Discord changes the protocol, update those two packages first.
- **Consent.** Recording is announced when it starts. Tell anyone who joins later yourself.

## Roadmap

- Video sync: a capture machine records the Discord client window with OBS, and a small helper reads `session.json` to trim or offset the video to `startedAtMs`.
