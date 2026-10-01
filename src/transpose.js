// /scribe transpose: declaring that a Discord user's mic carries more than
// one party member, so their clips get split by voice (see diarize.js). The
// roster -- who is declared behind which account, in which server -- outlives
// any one recording, so it is kept as one small file rather than in a session.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MIN_PARTY_MEMBERS = 2;
export const MAX_PARTY_MEMBERS = 8;
const MAX_NAME_LENGTH = 32;

function rosterFile(dataDir) {
  return join(dataDir, 'transpose.json');
}

async function loadRoster(dataDir) {
  try {
    return JSON.parse(await readFile(rosterFile(dataDir), 'utf8'));
  } catch {
    return {};
  }
}

async function saveRoster(dataDir, roster) {
  await writeFile(rosterFile(dataDir), JSON.stringify(roster, null, 2) + '\n');
}

/** The declared party members behind a Discord user in a guild, or null if none. */
export async function getMembers(dataDir, guildId, userId) {
  const roster = await loadRoster(dataDir);
  return roster[guildId]?.[userId] ?? null;
}

export async function setMembers(dataDir, guildId, userId, names) {
  const roster = await loadRoster(dataDir);
  roster[guildId] ??= {};
  roster[guildId][userId] = names;
  await saveRoster(dataDir, roster);
}

export async function clearMembers(dataDir, guildId, userId) {
  const roster = await loadRoster(dataDir);
  if (!roster[guildId]?.[userId]) return false;
  delete roster[guildId][userId];
  if (!Object.keys(roster[guildId]).length) delete roster[guildId];
  await saveRoster(dataDir, roster);
  return true;
}

/**
 * Parse `/scribe transpose`'s comma-separated names option.
 * @throws {Error} with a user-facing message if the list is not usable
 */
export function parseNames(raw) {
  const seen = new Set();
  const names = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (name.length > MAX_NAME_LENGTH) throw new Error(`"${name}" is too long (max ${MAX_NAME_LENGTH} characters).`);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length < MIN_PARTY_MEMBERS) {
    throw new Error(`Give at least ${MIN_PARTY_MEMBERS} comma-separated names, e.g. \`Alice, Bob\`.`);
  }
  if (names.length > MAX_PARTY_MEMBERS) {
    throw new Error(`That's ${names.length} names; scribbydascribe only splits a mic into at most ${MAX_PARTY_MEMBERS}.`);
  }
  return names;
}
