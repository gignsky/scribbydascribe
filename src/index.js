#!/usr/bin/env node
// scrivener: records a Discord voice call and writes a per-speaker transcript.
//
//   /scribe start   join your voice channel and begin recording
//   /scribe stop    finish, write the files, post the transcript here
//   /scribe status  what is being recorded right now

import { mkdir } from 'node:fs/promises';
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { loadConfig } from './config.js';
import { RecordingSession } from './session.js';
import { Transcriber } from './transcriber.js';
import { clock } from './output.js';

const cfg = loadConfig();
await mkdir(cfg.dataDir, { recursive: true });

const transcriber = new Transcriber(cfg);
transcriber.start();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/** guildId -> RecordingSession (one recording per server at a time) */
const sessions = new Map();
/** guildId -> timeout handle while the bot sits alone */
const aloneTimers = new Map();

const command = new SlashCommandBuilder()
  .setName('scribe')
  .setDescription('Record and transcribe this voice call')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('start').setDescription('Join your voice channel and start recording'))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop recording and post the transcript'))
  .addSubcommand((s) => s.setName('status').setDescription('Show the current recording'));

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  if (cfg.guildId) {
    const guild = await c.guilds.fetch(cfg.guildId);
    await guild.commands.set([command.toJSON()]);
    console.log(`[bot] commands registered in ${guild.name}`);
  } else {
    await c.application.commands.set([command.toJSON()]);
    console.log('[bot] commands registered globally');
  }
});

async function finishAndPost(session, reason) {
  sessions.delete(session.guild.id);
  clearTimeout(aloneTimers.get(session.guild.id));
  aloneTimers.delete(session.guild.id);

  const res = await session.stop(reason);
  const files = [new AttachmentBuilder(`${res.dir}/transcript.md`), new AttachmentBuilder(`${res.dir}/transcript.srt`)];
  const speakers = new Set(res.lines.map((l) => l.speaker)).size;
  const notes = [];
  if (res.failed) notes.push(`${res.failed} clip(s) failed to transcribe`);
  if (res.tracksError) notes.push('speaker tracks could not be built');

  const text =
    `⏹️ Recording of **${session.voiceChannel.name}** ended (${reason}). ` +
    `${clock(res.meta.durationMs)}, ${speakers} speaker(s), ${res.lines.length} line(s).` +
    (notes.length ? `\n⚠️ ${notes.join('; ')}.` : '');
  try {
    await session.textChannel.send({ content: text, files });
  } catch (err) {
    console.error('[bot] could not post transcript:', err.message);
  }
  console.log(`[bot] session saved to ${res.dir}`);
  return res;
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'scribe' || !i.inGuild()) return;
  const sub = i.options.getSubcommand();
  const current = sessions.get(i.guildId);

  if (sub === 'status') {
    if (!current) return i.reply({ content: 'Not recording.', flags: MessageFlags.Ephemeral });
    const s = current.stats;
    return i.reply({
      content:
        `🔴 Recording **${current.voiceChannel.name}** for ${clock(s.durationMs)}: ` +
        `${s.speakers} speaker(s), ${s.lines} line(s) so far, ${s.pending} clip(s) waiting to transcribe.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'stop') {
    if (!current) return i.reply({ content: 'Not recording.', flags: MessageFlags.Ephemeral });
    await i.reply(`Stopping. Finishing the transcript…`);
    await finishAndPost(current, `stopped by ${i.user.displayName}`);
    return;
  }

  // start
  if (current) {
    return i.reply({ content: `Already recording **${current.voiceChannel.name}**.`, flags: MessageFlags.Ephemeral });
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
    `Everything said in the channel is being saved. Use \`/scribe stop\` to end it.`;
  if (i.deferred) await i.editReply(notice);
  else await i.channel.send(notice);
  if (voiceChannel.isTextBased() && voiceChannel.id !== i.channelId) {
    await voiceChannel.send(notice).catch(() => {});
  }
});

// Leave on our own once everyone else has gone.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
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
});

// A failed reply or a lost interaction must never take down a recording.
process.on('unhandledRejection', (err) => console.error('[bot] unhandled:', err));

// systemd / podman stop: finish every recording properly before exiting.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bot] ${signal}: finishing ${sessions.size} recording(s)`);
  await Promise.allSettled([...sessions.values()].map((s) => finishAndPost(s, 'bot shutting down')));
  transcriber.stop();
  await client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await client.login(cfg.token);
