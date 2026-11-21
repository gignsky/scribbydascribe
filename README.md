# Scribby (scribbydascribe)

**A Discord bot that sits in your voice call and writes down who said what.** Start it with `/scribe start`, play your session or hold your meeting, and when you `/scribe stop` it posts a timestamped transcript, with every line labelled by the person who said it.

It was built for a D&D game, so it also rolls dice, keeps the table's text chat next to the speech, and makes a best-effort split of several players sharing one mic.

> **Status: early.** Scribby runs on one machine its maintainer looks after, and is being tried on a handful of servers. Expect rough edges, and expect the transcript to arrive a while after a long call (see [How long a transcript takes](#how-long-a-transcript-takes)).

## What you get

When a recording stops, Scribby posts `transcript.md` and `transcript.srt` in the channel where it was started. An example (names and words made up):

```markdown
# The Gilded Table / Session Zero — 2026-11-14 23:00 UTC

- Started: 2026-11-14T23:00:04.000Z
- Duration: 02:41:17
- Speakers: Rook, Mara, Teodor, Wren
- Chat: 12 message(s) in 2 text channel(s), marked 💬
- Timestamps are offsets from the start time above.

---

**[00:00:12] Rook:** Okay, everyone's here. Last time you'd just reached the gate of the drowned abbey.

**[00:00:19] Mara:** And we still haven't paid the ferryman, right?

**[00:00:23] Rook:** You have not paid the ferryman.

💬 **[00:00:31] Wren in #table-talk:** brb, grabbing snacks

**[00:00:35] Teodor:** I'll check the gate for traps while Wren's away.
```

Each person's line comes from their own audio stream, so speakers are never guessed. You can also export past sessions as JSONL, CSV or Markdown, and each recording keeps one audio track per speaker.

## Getting Scribby on your server

**[Add Scribby to your server](https://discord.com/oauth2/authorize?client_id=1552827800128327680&permissions=1084416&integration_type=0&scope=bot+applications.commands)**

Someone with **Manage Server** opens that link and picks your server. That is the whole install: nothing to host and no token to set up. The maintainer gets a note whenever a recording starts, so new servers don't go unnoticed.

The link asks for only what the bot uses:

| Permission | Why |
|---|---|
| View Channels, Send Messages, Attach Files | To announce recordings and post the transcript files |
| Connect | To join the voice channel it records |
| Slash commands (`applications.commands`) | So `/scribe` and `/roll` show up |

Then:
1. Run `/scribe help` to check the commands are there. New servers can take up to an hour to see them.
2. Tell your members before the first recording, and pin a short note saying the server uses Scribby (see below).
3. To limit who can record, use **Server Settings → Integrations → scribbydascribe** and restrict `/scribe`. By default anyone who can see the command can start a recording.
4. To keep a text channel out of transcripts, hide it from the bot's role.

## Privacy and consent

Please read this before you record anyone.

- **Everyone is told.** `/scribe start` announces the recording in the channel it was run in and in the voice channel's chat. Anyone who joins the call while it is recording is told too, by name. Pausing and resuming are announced the same way.
- **What is kept:** the audio of each speaker, the transcript, and, while recording, messages posted in any text channel the bot can see (a channel hidden from the bot's role is never read, and the maintainer can turn chat recording off altogether). Nothing is captured while a recording is paused.
- **Where it lives:** on the maintainer's own machine, not a cloud service. Speech is turned into text on that machine too (with Whisper), so audio is never sent to a transcription company.
- **Who sees it:** the transcript is posted in your server. Exports only ever show your own server's sessions to people in your server.
- **Opting out:** anyone who doesn't want to be recorded can leave the call or ask for `/scribe stop`. Ask everyone first: in some places (several US states, and much of Europe) recording a conversation needs everyone's consent, not just one person's.
- **Deleting a recording:** recordings are kept until deleted. Ask the maintainer to delete a session and its audio.

## How long a transcript takes

Transcription runs on a CPU, in the order recordings come in, shared between every server using this copy of Scribby. It usually keeps up with one lively call as it goes, and falls behind when several servers record at once. After `/scribe stop`, a progress message shows the steps left and a rough time remaining, and the transcript posts when it is done. `/scribe status` shows the same at any time.

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

## Running Scribby yourself

The rest of this README is for whoever hosts the bot.

### Setting up the Discord bot (one time)

1. Go to <https://discord.com/developers/applications>, choose **New Application**, open **Bot**, and choose **Reset Token**. Copy the token.
2. On the same **Bot** page, under Privileged Gateway Intents, switch on **Message Content Intent**. This lets the bot record text chat alongside the call. It is the only privileged intent needed; without it, voice is still recorded.
3. Build the invite URL. Open **OAuth2 → URL Generator** and set:
   - **Scopes:** tick both `bot` and `applications.commands`. Without `applications.commands` the bot joins but the server gets no slash commands. The **Bot Permissions** box appears only after you tick `bot`.
   - **Bot Permissions:** View Channels, Send Messages and Attach Files (under Text Permissions), and Connect (under Voice Permissions). Nothing else is needed.
   - **Integration Type:** Guild Install.
   - **Redirect URL:** leave it empty.

   The generated URL should look like this, with your application ID from **General Information** (the hosted Scribby's is `1552827800128327680`, used in the link at the top):
   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=1084416&integration_type=0&scope=bot+applications.commands
   ```
   `1084416` is those four permissions together, so you can also type the URL by hand. The bot also prints this link to its log when it starts (`[bot] invite link: …`). Open it, pick the server, and authorize. You need Manage Server on that server. Use the same URL for every server you add the bot to.

   Chat is only recorded from text channels where the bot has View Channels, so hide a channel from the bot's role to keep it out.
4. Optional: to control who may record, use Server Settings → Integrations → scribbydascribe.
5. For anyone but you to add the bot, **Public Bot** must be on under **Bot**. Turn it off to keep the invite link to yourself.
6. You get a DM whenever someone else starts a recording, on any server (see `SCRIBBYDASCRIBE_NOTIFY_OWNER` below).

**If a server has the bot but no commands:**
- `DISCORD_GUILD_ID` may be set (see the deployment section below). It registers the commands in that one server only, so any other server gets none. Remove it to register them everywhere. Global commands can take up to an hour to appear.
- The bot may have been invited without the `applications.commands` scope. Kick it and invite it again with the URL above.

### Deploying on spacedock

1. Push to the `master` branch of `github:gignsky/scribbydascribe`. `master` is the release branch that spacedock deploys.
2. Add the secret with `just sops`, as a key `scribbydascribe-env` whose value is an env file:
   ```
   DISCORD_TOKEN=...
   DISCORD_GUILD_ID=...   # optional, for testing: registers the commands instantly, but ONLY in that server. Leave it out to use the bot in more than one server.
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
| `SCRIBBYDASCRIBE_NOTIFY_OWNER` | `true` | DM the bot's owner whenever someone else starts a recording, on any server: who started it, the server, the voice channel and a link to it. Recordings the owner starts are not reported. The owner must share a server with the bot and accept DMs from it. |
| `SCRIBBYDASCRIBE_OWNER_ID` | the application's owner | The Discord user ID to DM instead of the application's owner (or, for an app owned by a team, the team's owner). |

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
- **Consent.** Recording is announced when it starts, and to each person who joins while it runs. It cannot tell who has agreed: anyone who has not should leave the call. See [Privacy and consent](#privacy-and-consent).

## Roadmap

- Video sync: a capture machine records the Discord client window with OBS, and a small helper reads `session.json` to trim or offset the video to `startedAtMs`.

## scribby-live: a live transcript in a text file (CLI)

The same Whisper pipeline without Discord, for a shell on a workstation (merlin). It listens to a microphone, or whatever the machine is playing, and appends what it hears to a plain text file as it is said, so Claude (or `tail -f`) can read the file while it grows.

```
nix shell .#scribbydascribe -c scribby-live -o ~/live.txt
```

From a checkout: `nix develop -c node src/cli.js -o ~/live.txt` (or `npm run live -- -o ~/live.txt`).

The file only ever grows. Each utterance is complete when it appears, as a Markdown paragraph, `**[HH:MM:SS] label:** text` (`--format txt`, or a `.txt` file name, gives plain `[HH:MM:SS] label: text` lines), with the time counted from the start of the run (the header line the run writes says when that was). Point Claude at the file, e.g. `tail -n 40 ~/live.txt`, or watch it with the Monitor tool.

| Option | |
|---|---|
| `-o, --output FILE` | transcript file (default `./live-transcript.md`); appended to, `--fresh` empties it first |
| `-s, --source label=device` | what to hear; repeat it to label several. On a call, `-s me=default -s them=<sink>.monitor` (`pactl list short sources`) tells your voice from everyone else's |
| `--no-follow` | by default, on a terminal, new lines are also shown there as they are written, like `tail -f`; this turns that off (`--follow` forces it when piped) |
| `-f, --file PATH` | read raw 16 kHz mono s16le from a file or `-` (stdin) instead of a mic |
| `-m, --model` | `tiny`/`base`/`small`/`medium`. Default `small`; if it logs "falling behind", go smaller |
| `-l, --language` | e.g. `en`, `de`, or `auto` |
| `--translate` | write English for speech in any language (Whisper's translate task) |
| `--silence`, `--max-clip`, `--threshold` | how pauses cut utterances (ms, ms, loudness) |

An utterance appears after you pause (0.7 s by default) or after 10 s of continuous speech. Ctrl-C finishes what was heard and exits. Needs `parecord` or `pw-record` on the PATH. Speech is labelled by source only; there is no per-person split within one source.
