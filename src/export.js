// /scribe export: combine the transcripts of chosen sessions into one file,
// one row per spoken line or chat message, for loading into another dataset;
// or one readable Markdown transcript of them all; or their call audio.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { toMarkdown } from './output.js';

export const FORMATS = ['jsonl', 'csv', 'md', 'audio'];
/** What each format's menu prompt promises. */
export const FORMAT_BLURB = {
  jsonl: 'one **jsonl** file, one row per spoken line or chat message',
  csv: 'one **csv** file, one row per spoken line or chat message',
  md: 'one **Markdown** transcript, speech and chat together',
  audio: 'their **audio**, the whole call mixed down, one file per session',
};
/** Discord allows at most 25 options in one select menu. */
export const MAX_CHOICES = 25;

/**
 * Finished sessions of one server, newest first. Each is the session's
 * transcript.json (meta + lines) plus its folder name and a stable `key`
 * short enough for a select-menu value.
 */
export async function listSessions(sessionsDir, guildId) {
  let names;
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const folder of names) {
    let t;
    try {
      t = JSON.parse(await readFile(join(sessionsDir, folder, 'transcript.json'), 'utf8'));
    } catch {
      continue; // still recording, or not a session folder
    }
    if (t.guildId !== guildId) continue;
    out.push({ ...t, folder, key: `${t.startedAtMs}-${t.channelId}` });
  }
  return out.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/** Every spoken line and chat message of the chosen sessions as flat rows, in time order. */
export function exportRows(sessions) {
  const rows = [];
  for (const s of sessions) {
    const common = {
      session: s.folder,
      guild: s.guildName,
      channel: s.channelName,
      session_started_at: s.startedAt,
    };
    for (const l of s.lines ?? []) {
      rows.push({
        ...common,
        kind: 'speech',
        text_channel: '',
        speaker: l.speaker,
        speaker_id: l.speakerId,
        start_ms: l.startMs,
        end_ms: l.endMs,
        start_at: new Date(s.startedAtMs + l.startMs).toISOString(),
        text: l.text,
      });
    }
    for (const m of s.chat ?? []) {
      rows.push({
        ...common,
        kind: 'chat',
        text_channel: m.channel,
        speaker: m.author,
        speaker_id: m.authorId,
        start_ms: m.atMs,
        end_ms: m.atMs,
        start_at: new Date(s.startedAtMs + m.atMs).toISOString(),
        text: [m.text, ...(m.attachments ?? []).map((a) => a.url)].filter(Boolean).join(' '),
      });
    }
  }
  return rows.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.session.localeCompare(b.session));
}

export const COLUMNS = ['session', 'guild', 'channel', 'session_started_at', 'kind', 'text_channel', 'speaker', 'speaker_id', 'start_ms', 'end_ms', 'start_at', 'text'];

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {'jsonl'|'csv'} format */
export function renderExport(rows, format) {
  if (format === 'csv') {
    return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvField(r[c])).join(','))].join('\r\n') + '\r\n';
  }
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/**
 * One Markdown document: each chosen session's transcript, speech and chat
 * interleaved as in its own transcript.md, oldest session first.
 */
export function renderMarkdown(sessions) {
  const sorted = [...sessions].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const lines = sorted.reduce((n, s) => n + (s.lines ?? []).length, 0);
  const chat = sorted.reduce((n, s) => n + (s.chat ?? []).length, 0);
  const head = [
    '# Scrivener export',
    '',
    `${sorted.length} session(s), ${lines} spoken line(s)` + (chat ? `, ${chat} chat message(s)` : '') + ', oldest first.',
    '',
  ];
  // Each session's own title becomes a section heading under the export's.
  const parts = sorted.map((s) => toMarkdown(s, s.lines ?? [], s.chat ?? []).replace(/^# /, '## '));
  return head.join('\n') + '\n' + parts.join('\n');
}

/**
 * The audio of each chosen session: tracks/mix.ogg, or the one speaker's track
 * when only one person spoke (no mix is made then). Sessions without audio,
 * say because the tracks could not be built, come back with `path: null`.
 * @returns {Promise<Array<{session:object, path:string|null, name:string, size:number}>>}
 */
export async function audioFiles(sessionsDir, sessions) {
  const out = [];
  for (const s of [...sessions].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
    const dir = join(sessionsDir, s.folder, 'tracks');
    let names = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.ogg'));
    } catch {
      // no tracks folder
    }
    const pick = names.includes('mix.ogg') ? 'mix.ogg' : names.length === 1 ? names[0] : null;
    const path = pick && join(dir, pick);
    out.push({ session: s, path, name: `${s.folder}.ogg`, size: path ? (await stat(path)).size : 0 });
  }
  return out;
}

/**
 * Splits files into those that fit in one Discord reply (at most `maxFiles`,
 * `maxBytes` in all, in order) and the rest, to be saved on the host.
 */
export function planUpload(files, maxBytes, maxFiles = 10) {
  const upload = [];
  const save = [];
  let used = 0;
  for (const f of files) {
    if (upload.length < maxFiles && used + f.size <= maxBytes) {
      upload.push(f);
      used += f.size;
    } else {
      save.push(f);
    }
  }
  return { upload, save };
}

function utc(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function hms(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`;
}

/** Label and description for a session's select-menu option (each ≤ 100 chars). */
export function choiceFor(s) {
  const speakers = new Set((s.lines ?? []).map((l) => l.speaker)).size;
  return {
    label: `${s.channelName} · ${utc(s.startedAtMs)} UTC`.slice(0, 100),
    description: (
      `${hms(s.durationMs)}, ${speakers} speaker(s), ${(s.lines ?? []).length} line(s)` +
      (s.chat?.length ? `, ${s.chat.length} chat message(s)` : '')
    ).slice(0, 100),
    value: s.key,
  };
}
