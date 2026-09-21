/**
 * Space registry.
 *
 * Remembers the spaces we have seen (id, type, phone, display name) so that
 * `zylos-imessage status` and any future admin tooling can show who is on the
 * other end without hitting the API. Sending does not depend on this file —
 * the daemon resolves a Space from its id directly.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

export const SPACES_PATH = path.join(DATA_DIR, 'spaces.json');
const MAX_SPACES = 500;

export function loadSpaces(filePath = SPACES_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSpaces(spaces, filePath = SPACES_PATH) {
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(spaces, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.warn(`[imessage] Failed to persist spaces: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/**
 * Record a sighting. Returns the updated map, or the original object when
 * nothing changed, so callers can skip a needless write.
 *
 * @returns {{spaces: Object, changed: boolean}}
 */
export function recordSpace(spaces, { id, type, phone, name, seenAt }) {
  if (!id) return { spaces, changed: false };
  const key = String(id);
  const prev = spaces[key];
  const next = {
    type: type || prev?.type || 'dm',
    phone: phone ?? prev?.phone ?? null,
    name: name ?? prev?.name ?? null,
    firstSeen: prev?.firstSeen || seenAt,
    lastSeen: seenAt
  };

  const changed =
    !prev ||
    prev.type !== next.type ||
    prev.phone !== next.phone ||
    prev.name !== next.name;

  spaces[key] = next;

  // Bound the file: evict least-recently-seen entries.
  const keys = Object.keys(spaces);
  if (keys.length > MAX_SPACES) {
    keys
      .sort((a, b) => String(spaces[a].lastSeen || '').localeCompare(String(spaces[b].lastSeen || '')))
      .slice(0, keys.length - MAX_SPACES)
      .forEach(k => delete spaces[k]);
    return { spaces, changed: true };
  }

  return { spaces, changed };
}
