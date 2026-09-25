#!/usr/bin/env node
// scrivener: records a Discord voice call and writes a per-speaker transcript.
//
//   /scribe start   join your voice channel and begin recording
//   /scribe pause   stop capturing audio, but stay in the call
//   /scribe resume  capture again after a pause
//   /scribe stop    finish, write the files, post the transcript here
//   /scribe status  what is being recorded, or how far a stopped one has got
//   /scribe export  combine chosen sessions' transcripts into one file
//   /scribe help    list the commands
//   /roll           roll dice, e.g. `/roll 2d20kh1+5`; kept in any recording

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { loadConfig } from './config.js';
import { intentsFor, isDisallowedIntents, probeChatIntent } from './intents.js';
import { RecordingSession } from './session.js';
import { Transcriber } from './transcriber.js';
import { clock } from './output.js';
import { HELP, describe } from './status.js';
import { roll } from './dice.js';
import { FORMATS, MAX_CHOICES, choiceFor, exportRows, listSessions, renderExport } from './export.js';

const cfg = loadConfig();
await mkdir(cfg.dataDir, { recursive: true });

const transcriber = new Transcriber(cfg);
transcriber.start();

// Text chat is recorded alongside speech when the privileged Message Content
// intent is switched on for the bot. If it is not, carry on without: voice is
// the point, chat is the bonus.
let recordChat = cfg.recordChat;

const HOW_TO_ENABLE_CHAT =
  'Turn on "Message Content Intent" under Bot at https://discord.com/developers/applications and restart, ' +
  'or set SCRIVENER_RECORD_CHAT=false to stop asking.';

// Asking Discord for a privileged intent it has not granted is fatal, not
// merely refused: the gateway closes with 4014 and the error surfaces as an
// uncaught exception from inside the websocket stack, where neither the
// try/catch around login() below nor the unhandledRejection handler can
// reach it. So settle the question over REST first, while a plain answer is
// still on offer. A null verdict means the probe could not tell, and the
// gateway decides after all -- see withoutChat.
if (recordChat && (await probeChatIntent(cfg.token)) === false) {
  recordChat = false;
  console.error(`[bot] Message Content is not enabled for this bot, so text chat will NOT be recorded. ${HOW_TO_ENABLE_CHAT}`);
}

function makeClient() {
  const c = new Client({ intents: intentsFor(recordChat) });
  c.once(Events.ClientReady, onReady);
  c.on(Events.InteractionCreate, onInteraction);
  c.on(Events.VoiceStateUpdate, onVoiceStateUpdate);
  c.on(Events.MessageCreate, onMessage);
  c.on(Events.ShardDisconnect, (ev) => {
    if (isDisallowedIntents(ev)) withoutChat();
  });
  // A discord.js client is a Node EventEmitter, which throws whatever it is
  // handed when nothing is listening for "error". Listening keeps a bad
  // moment on the gateway from becoming a dead process.
  for (const event of [Events.Error, Events.ShardError]) {
    c.on(event, (err) => {
      if (isDisallowedIntents(err)) withoutChat();
      else console.error('[bot] gateway error:', err);
    });
  }
  return c;
}

let fallback = null;
function withoutChat() {
  if (!recordChat) return fallback;
  recordChat = false;
  console.error(`[bot] Discord refused the Message Content intent, so text chat will NOT be recorded. ${HOW_TO_ENABLE_CHAT}`);
  fallback = reconnect();
  return fallback;
}

// Reconnect asking for voice only. Losing this leaves the bot logged out and
// silent, which looks like it is working, so make it a visible death that
// the service manager will restart instead.
async function reconnect() {
  const old = client;
  client = makeClient();
  try {
    await old.destroy();
    await client.login(cfg.token);
  } catch (err) {
    console.error('[bot] could not reconnect without the chat intent:', err);
    process.exit(1);
  }
}

/** guildId -> RecordingSession (one recording per server at a time) */
const sessions = new Map();
/** RecordingSession -> promise, for sessions stopped but not yet posted */
const finishing = new Map();
/** guildId -> timeout handle while the bot sits alone */
const aloneTimers = new Map();

const command = new SlashCommandBuilder()
  .setName('scribe')
  .setDescription('Record and transcribe this voice call')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('start').setDescription('Join your voice channel and start recording'))
  .addSubcommand((s) => s.setName('pause').setDescription('Stop capturing audio for now, but stay in the call'))
  .addSubcommand((s) => s.setName('resume').setDescription('Start capturing audio again after a pause'))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop recording and post the transcript'))
  .addSubcommand((s) => s.setName('status').setDescription('Show the recording, or the progress of its transcript'))
  .addSubcommand((s) =>
    s
      .setName('export')
      .setDescription('Combine chosen sessions into one file for another dataset')
      .addStringOption((o) =>
        o
          .setName('format')
          .setDescription('File format (default: jsonl)')
          .addChoices(...FORMATS.map((f) => ({ name: f, value: f }))),
      ),
  )
  .addSubcommand((s) => s.setName('help').setDescription('List the /scribe commands'));

const rollCommand = new SlashCommandBuilder()
  .setName('roll')
  .setDescription('Roll dice, e.g. d20, 2d6+3, 4d6kh3 or 2d20kh1+5')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('dice').setDescription('Dice notation (default: d20)').setMaxLength(100))
  .addStringOption((o) => o.setName('for').setDescription('What the roll is for, e.g. "perception"').setMaxLength(100));

const commands = [command.toJSON(), rollCommand.toJSON()];

// A bot upload is capped at 10 MiB; anything larger is saved on the host instead.
const MAX_UPLOAD = 10 * 1024 * 1024;

/** /scribe export: offer this server's finished sessions to choose from. */
async function offerExport(i) {
  const format = i.options.getString('format') ?? 'jsonl';
  const all = await listSessions(cfg.dataDir, i.guildId);
  if (!all.length) return i.reply({ content: 'No finished sessions to export yet.', flags: MessageFlags.Ephemeral });
  const shown = all.slice(0, MAX_CHOICES);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`scribe-export:${format}`)
    .setPlaceholder('Sessions to combine')
    .setMinValues(1)
    .setMaxValues(shown.length)
    .addOptions(shown.map(choiceFor));
  return i.reply({
    content:
      `Pick the sessions to combine into one **${format}** file, one row per spoken line.` +
      (all.length > shown.length ? ` Showing the ${shown.length} most recent of ${all.length}.` : ''),
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

/** The menu choice: build the file and hand it back. */
async function sendExport(i) {
  const format = i.customId.split(':')[1];
  if (!FORMATS.includes(format)) return;
  await i.update({ content: `Building the ${format} export…`, components: [] });
  // Resolve choices against the listing, never against the raw values.
  const chosen = (await listSessions(cfg.dataDir, i.guildId)).filter((s) => i.values.includes(s.key));
  const rows = exportRows(chosen);
  const body = Buffer.from(renderExport(rows, format));
  const name = `scrivener-export_${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')}.${format}`;
  const summary = `${chosen.length} session(s), ${rows.length} line(s)`;
  if (body.length <= MAX_UPLOAD) {
    return i.editReply({ content: `📦 Export ready: ${summary}.`, files: [new AttachmentBuilder(body, { name })] });
  }
  await mkdir(cfg.exportDir, { recursive: true });
  await writeFile(join(cfg.exportDir, name), body);
  return i.editReply({
    content: `📦 Export ready: ${summary}. It is ${(body.length / 1048576).toFixed(1)} MiB, too big to upload here, so it was saved on the host as \`${name}\` in the exports folder.`,
  });
}

/** /roll: roll in public, and into this server's recording if there is one. */
async function rollDice(i) {
  const expr = i.options.getString('dice') ?? 'd20';
  const label = i.options.getString('for');
  let r;
  try {
    r = roll(expr);
  } catch (err) {
    return i.reply({ content: `🎲 ${err.message}`, flags: MessageFlags.Ephemeral });
  }
  // Show the working only when there is some; `d20` alone is just the number.
  // A hundred dice of working can outrun Discord's 2000-character limit.
  const plain = r.terms.length === 1 && r.terms[0].count === 1;
  const shown = plain || r.working.length > 1500 ? '' : ` ${r.working} =`;
  const text = `🎲 rolled \`${r.notation}\`${label ? ` for ${label}` : ''}:${shown} **${r.total}**`;
  const reply = await i.reply({ content: `${i.user} ${text}`, withResponse: true });
  sessions.get(i.guildId)?.recordRoll({
    at: i.createdTimestamp,
    messageId: reply.resource?.message?.id ?? null,
    channel: i.channel,
    user: i.user,
    member: i.member,
    text,
  });
}

async function onReady(c) {
  console.log(`[bot] logged in as ${c.user.tag}${recordChat ? '; recording text chat too' : ''}`);
  if (cfg.guildId) {
    const guild = await c.guilds.fetch(cfg.guildId);
    await guild.commands.set(commands);
    console.log(`[bot] commands registered in ${guild.name}`);
  } else {
    await c.application.commands.set(commands);
    console.log('[bot] commands registered globally');
  }
}

/** Text messages anywhere in a server being recorded go into its session. */
function onMessage(msg) {
  if (!recordChat || !msg.inGuild() || msg.author.id === msg.client.user.id) return;
  sessions.get(msg.guildId)?.recordMessage(msg);
}

/**
 * Stop a session and post its transcript. Idempotent: a stop, a dropped
 * connection and the alone timer can all race here, and it posts once.
 */
function finishAndPost(session, reason) {
  if (!finishing.has(session)) {
    const job = postTranscript(session, reason).finally(() => finishing.delete(session));
    finishing.set(session, job);
  }
  return finishing.get(session);
}

async function postTranscript(session, reason) {
  // Only clear the slot if it is still ours; a new recording may have started.
  if (sessions.get(session.guild.id) === session) {
    sessions.delete(session.guild.id);
    clearTimeout(aloneTimers.get(session.guild.id));
    aloneTimers.delete(session.guild.id);
  }

  const res = await session.stop(reason);
  const files = [new AttachmentBuilder(`${res.dir}/transcript.md`), new AttachmentBuilder(`${res.dir}/transcript.srt`)];
  const speakers = new Set(res.lines.map((l) => l.speaker)).size;
  const notes = [];
  if (res.failed) notes.push(`${res.failed} clip(s) failed to transcribe`);
  if (res.tracksError) notes.push('speaker tracks could not be built');

  const paused = res.meta.pausedMs > 0 ? ` (${clock(res.meta.pausedMs)} paused)` : '';
  const text =
    `⏹️ Recording of **${session.voiceChannel.name}** ended (${reason}). ` +
    `${clock(res.meta.durationMs)}${paused}, ${speakers} speaker(s), ${res.lines.length} line(s)` +
    (res.chat.length ? `, ${res.chat.length} chat message(s).` : '.') +
    (notes.length ? `\n⚠️ ${notes.join('; ')}.` : '');
  try {
    await session.textChannel.send({ content: text, files });
  } catch (err) {
    console.error('[bot] could not post transcript:', err.message);
  }
  console.log(`[bot] session saved to ${res.dir}`);
  return res;
}

async function onInteraction(i) {
  if (i.isStringSelectMenu() && i.customId.startsWith('scribe-export:') && i.inGuild()) {
    return sendExport(i).catch((err) => {
      console.error('[bot] export failed:', err);
      return i.editReply({ content: `Export failed: ${err.message}`, components: [] }).catch(() => {});
    });
  }
  if (i.isChatInputCommand() && i.commandName === 'roll' && i.inGuild()) return rollDice(i);
  if (!i.isChatInputCommand() || i.commandName !== 'scribe' || !i.inGuild()) return;
  const sub = i.options.getSubcommand();
  const current = sessions.get(i.guildId);

  if (sub === 'export') return offerExport(i);

  if (sub === 'help') {
    return i.reply({ content: HELP, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'status') {
    // The live recording, if any, then any stopped ones still being finished.
    const now = Date.now();
    const here = [current, ...[...finishing.keys()].filter((s) => s.guild.id === i.guildId)].filter(Boolean);
    const content = here.length ? here.map((s) => describe(s.snapshot, now)).join('\n\n') : 'Not recording.';
    return i.reply({ content, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'pause' || sub === 'resume') {
    if (!current) return i.reply({ content: 'Not recording.', flags: MessageFlags.Ephemeral });
    const name = current.voiceChannel.name;
    if (sub === 'pause' && !current.pause(i.user.displayName)) {
      return i.reply({ content: `Already paused. \`/scribe resume\` continues.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'resume' && !current.resume()) {
      return i.reply({ content: 'Not paused.', flags: MessageFlags.Ephemeral });
    }
    // Like the start notice, everyone in the call should know.
    const notice =
      sub === 'pause'
        ? `⏸️ **Recording of ${name} paused** by ${i.user}. Nothing said or posted now is saved. \`/scribe resume\` continues.`
        : `🔴 **Recording of ${name} resumed** by ${i.user}. ` +
          (recordChat ? 'Everything said in the channel and posted in the server is being saved again.' : 'Everything said in the channel is being saved again.');
    await i.reply(notice);
    if (current.voiceChannel.isTextBased() && current.voiceChannel.id !== i.channelId) {
      await current.voiceChannel.send(notice).catch(() => {});
    }
    return;
  }

  if (sub === 'stop') {
    if (!current) return i.reply({ content: 'Not recording.', flags: MessageFlags.Ephemeral });
    await i.reply(`Stopping. Finishing the transcript… \`/scribe status\` shows how far along it is.`);
    await finishAndPost(current, `stopped by ${i.user.displayName}`);
    return;
  }

  // start
  if (current) {
    const state = current.pausedAt ? 'Already recording (paused)' : 'Already recording';
    return i.reply({ content: `${state} **${current.voiceChannel.name}**.`, flags: MessageFlags.Ephemeral });
  }
  const member = await i.guild.members.fetch(i.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.type === ChannelType.GuildStageVoice) {
    return i.reply({ content: 'Join a voice channel first, then run `/scribe start`.', flags: MessageFlags.Ephemeral });
  }
  if (!transcriber.ready) {
    await i.reply({ content: 'The speech model is still loading; recording will start, and transcription will catch up.', flags: MessageFlags.Ephemeral });
  } else {
    await i.deferReply();
  }

  const session = new RecordingSession({
    cfg,
    transcriber,
    voiceChannel,
    textChannel: i.channel,
    startedBy: i.user,
    onLost: (reason) => finishAndPost(session, reason),
  });
  try {
    await session.start();
  } catch (err) {
    const msg = `Could not start recording: ${err.message}`;
    return i.deferred ? i.editReply(msg) : i.followUp(msg);
  }
  sessions.set(i.guildId, session);

  // Everyone in the call should know they are being recorded.
  const notice =
    `🔴 **Recording and transcribing ${voiceChannel.name}**, started by ${i.user}. ` +
    (recordChat
      ? `Everything said in the channel, and every message posted in this server's text channels, is being saved. `
      : `Everything said in the channel is being saved. `) +
    `Use \`/scribe stop\` to end it.`;
  if (i.deferred) await i.editReply(notice);
  else await i.channel.send(notice);
  if (voiceChannel.isTextBased() && voiceChannel.id !== i.channelId) {
    await voiceChannel.send(notice).catch(() => {});
  }
}

// Leave on our own once everyone else has gone.
function onVoiceStateUpdate(oldState, newState) {
  for (const guildId of new Set([oldState.guild.id, newState.guild.id])) {
    const session = sessions.get(guildId);
    if (!session) continue;
    const humans = session.voiceChannel.members.filter((m) => !m.user.bot).size;
    const timer = aloneTimers.get(guildId);
    if (humans === 0 && !timer) {
      aloneTimers.set(
        guildId,
        setTimeout(() => finishAndPost(session, 'everyone left'), cfg.aloneTimeoutMs),
      );
    } else if (humans > 0 && timer) {
      clearTimeout(timer);
      aloneTimers.delete(guildId);
    }
  }
}

// A failed reply or a lost interaction must never take down a recording.
process.on('unhandledRejection', (err) => console.error('[bot] unhandled:', err));

// The last net under the intent fallback. A refused intent is thrown out of a
// websocket close handler, so it arrives here rather than at any catch we can
// write; recovering is a reconnect, not a restart. Everything else keeps
// Node's usual fate -- report it and exit, so the service manager starts a
// clean process rather than one left in an unknown state.
process.on('uncaughtException', (err) => {
  if (recordChat && isDisallowedIntents(err)) {
    withoutChat();
    return;
  }
  console.error('[bot] fatal:', err);
  process.exit(1);
});

// systemd / podman stop: finish every recording properly before exiting.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bot] ${signal}: finishing ${sessions.size + finishing.size} recording(s)`);
  // Stopped sessions still transcribing must finish too, or stopping the
  // worker below would cut their transcripts short.
  for (const s of sessions.values()) finishAndPost(s, 'bot shutting down');
  await Promise.allSettled([...finishing.values()]);
  transcriber.stop();
  await client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

let client = makeClient();
try {
  await client.login(cfg.token);
} catch (err) {
  // A refusal may already have arrived by another route and started a
  // voice-only reconnect, in which case this failure is stale news and the
  // reconnect is the one whose outcome matters.
  if (fallback) await fallback;
  else if (isDisallowedIntents(err)) await withoutChat();
  else {
    // Rethrowing here only reaches the unhandledRejection handler above,
    // which would log the failure and leave a live process that is not
    // logged in to anything. Die instead, and let the service manager retry.
    console.error('[bot] could not log in:', err);
    process.exit(1);
  }
}
