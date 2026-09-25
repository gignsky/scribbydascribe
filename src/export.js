// /scribe export: combine the transcripts of chosen sessions into one file,
// one row per spoken line, for loading into another dataset.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FORMATS = ['jsonl', 'csv'];
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

/** Every line of the chosen sessions as flat rows, in time order. */
export function exportRows(sessions) {
  const rows = [];
  for (const s of sessions) {
    for (const l of s.lines ?? []) {
      rows.push({
        session: s.folder,
        guild: s.guildName,
        channel: s.channelName,
        session_started_at: s.startedAt,
        speaker: l.speaker,
        speaker_id: l.speakerId,
        start_ms: l.startMs,
        end_ms: l.endMs,
        start_at: new Date(s.startedAtMs + l.startMs).toISOString(),
        text: l.text,
      });
    }
  }
  return rows.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.session.localeCompare(b.session));
}

export const COLUMNS = ['session', 'guild', 'channel', 'session_started_at', 'speaker', 'speaker_id', 'start_ms', 'end_ms', 'start_at', 'text'];

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
    description: `${hms(s.durationMs)}, ${speakers} speaker(s), ${(s.lines ?? []).length} line(s)`.slice(0, 100),
    value: s.key,
  };
}
