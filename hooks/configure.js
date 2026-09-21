#!/usr/bin/env node
/**
 * Configure hook for zylos-imessage
 *
 * Called by zylos after collecting SKILL.md config.required values.
 * Receives a JSON object on stdin and writes component-owned config.json.
 *
 * Example stdin:
 *   { "IMESSAGE_PROJECT_ID": "...", "IMESSAGE_PROJECT_SECRET": "..." }
 *
 * The collected names are mapped through an explicit allowlist rather than
 * derived from the env name: src/lib/config.js reads camelCase keys, so a
 * mechanical prefix-strip + lowercase would write `project_id` and the
 * daemon would silently never see the credential.
 *
 * config.json can hold the project secret, so it is written 0600 inside a
 * 0700 data dir, matching what src/lib/config.js expects and self-heals to.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/imessage');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const KEY_MAP = {
  IMESSAGE_PROJECT_ID: 'projectId',
  IMESSAGE_PROJECT_SECRET: 'projectSecret',
  IMESSAGE_DM_POLICY: 'dmPolicy',
  IMESSAGE_LOG_LEVEL: 'logLevel'
};

const DEFAULT_CONFIG = {
  enabled: true
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return { ...fallback };
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function writeJsonFile(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode only applies when it actually creates the directory, and
  // zylos usually creates the data dir first. Tighten it either way.
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode is ignored when the temp file already exists, so set
  // it explicitly before the rename publishes the contents.
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

try {
  const raw = (await readStdin()).trim();
  if (!raw) {
    throw new Error('Expected stdin JSON object with collected config values');
  }

  const collected = JSON.parse(raw);
  if (!collected || Array.isArray(collected) || typeof collected !== 'object') {
    throw new Error('Configure input must be a JSON object');
  }

  const config = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  const applied = [];
  const ignored = [];
  for (const [name, value] of Object.entries(collected)) {
    // Empty is not an error: credentials may already be in the environment,
    // in which case the installer legitimately collects nothing for them.
    if (value === undefined || value === null || value === '') continue;
    const key = KEY_MAP[name];
    if (!key) { ignored.push(name); continue; }
    config[key] = value;
    applied.push(key);
  }

  writeJsonFile(CONFIG_PATH, config);
  console.log(`[configure] Wrote config to ${CONFIG_PATH} (${applied.length ? applied.join(', ') : 'no new values'})`);
  if (ignored.length) {
    console.warn(`[configure] Ignored unrecognized key(s): ${ignored.join(', ')}`);
  }
} catch (err) {
  console.error(`[configure] ${err.message}`);
  process.exit(1);
}
