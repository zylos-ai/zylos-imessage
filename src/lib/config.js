/**
 * Configuration loader for zylos-imessage
 *
 * Config lives in ~/zylos/components/imessage/config.json.
 * Credentials (Photon PROJECT_ID / PROJECT_SECRET) may come from either
 * config.json or the environment (process.env or ~/zylos/.env), so an
 * operator can keep them out of the component data directory if preferred.
 *
 * Because config.json may hold the project secret, the file is kept at 0600.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/imessage');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const ZYLOS_ENV_PATH = path.join(HOME, 'zylos/.env');

export const DEFAULT_CONFIG = {
  enabled: true,

  // Photon credentials (may instead be supplied via env)
  projectId: null,
  projectSecret: null,

  // Access control. The owner is never inferred from inbound traffic: either
  // user_id is set here, or a sender proves possession of pairing.code.
  owner: { user_id: null, name: null, bound_at: null },
  // One-time binding over iMessage. `code` must be >= 8 chars to be accepted,
  // is consumed on first successful use, and is optional — leaving it null
  // means the owner can only be bound by editing this file.
  pairing: { code: null, expiresAt: null, maxAttempts: 5 },
  dmPolicy: 'owner',        // 'owner' | 'allowlist' | 'open'
  dmAllowFrom: [],
  // Photon's free shared number has no group chat; keep groups off by default.
  groupPolicy: 'disabled',  // 'disabled' | 'allowlist' | 'open'
  groups: {},

  message: {
    maxLength: 2000,
    chunkDelayMs: 600,
    stripMarkdown: true
  },
  dedupe: { ttlMs: 5 * 60 * 1000, maxEntries: 1000 },
  rateLimit: { windowMs: 60 * 1000, max: 60 },
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60 * 1000 },
  ipc: { requestTimeoutMs: 30000 },
  logLevel: 'info'
};

// Photon's own docs name these SPECTRUM_*; accepted as a fallback so a
// copy-pasted dashboard snippet works, with the component-scoped name winning.
const ENV_KEYS = {
  projectId: ['IMESSAGE_PROJECT_ID', 'SPECTRUM_PROJECT_ID'],
  projectSecret: ['IMESSAGE_PROJECT_SECRET', 'SPECTRUM_PROJECT_SECRET']
};

let config = null;
let configWatcher = null;
let watchDebounce = null;

/**
 * Minimal `.env` reader. Only used as a credential fallback, so it handles the
 * common `KEY=value` / `KEY="value"` forms and ignores everything else.
 */
export function readEnvFile(filePath = ZYLOS_ENV_PATH) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function mergeDefaults(base, overrides) {
  const merged = { ...base, ...overrides };
  // One level of deep-merge is enough for our shape; it keeps a partially
  // written config.json from wiping out defaults for sibling keys.
  for (const key of ['owner', 'pairing', 'message', 'dedupe', 'rateLimit', 'reconnect', 'ipc']) {
    merged[key] = { ...base[key], ...(overrides?.[key] || {}) };
  }
  return merged;
}

/** First non-empty value across the accepted env names, or null. */
function envCredential(field, fileEnv) {
  for (const envKey of ENV_KEYS[field]) {
    const value = process.env[envKey] || fileEnv[envKey];
    if (value) return value;
  }
  return null;
}

function applyCredentialFallback(cfg) {
  const fileEnv = readEnvFile();
  for (const field of Object.keys(ENV_KEYS)) {
    if (cfg[field]) continue;
    const value = envCredential(field, fileEnv);
    if (value) cfg[field] = value;
  }
  return cfg;
}

/** True when both Photon credentials are present. */
export function hasCredentials(cfg = getConfig()) {
  return Boolean(cfg.projectId && cfg.projectSecret);
}

/**
 * Tighten config.json to 0600 if it is more permissive. The file can carry the
 * project secret, so group/other readability is a real exposure.
 */
export function repairConfigPermissions(configPath = CONFIG_PATH) {
  try {
    const stats = fs.statSync(configPath);
    if ((stats.mode & 0o077) !== 0) {
      fs.chmodSync(configPath, 0o600);
      console.warn(`[imessage] Tightened ${configPath} permissions to 0600`);
      return true;
    }
  } catch {
    // Missing file is fine; it will be created at 0600 by saveConfig().
  }
  return false;
}

export function loadConfig() {
  let fromFile = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } else {
      console.warn(`[imessage] Config file not found: ${CONFIG_PATH}`);
    }
  } catch (err) {
    console.error(`[imessage] Failed to load config: ${err.message}`);
    fromFile = {};
  }
  config = applyCredentialFallback(mergeDefaults(DEFAULT_CONFIG, fromFile));
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}

/**
 * Persist config atomically at 0600. Credentials sourced from the environment
 * are not written back to disk — that would copy a secret into a second place.
 *
 * @returns {boolean} true on success
 */
export function saveConfig(newConfig) {
  const toWrite = { ...newConfig };
  const fileEnv = readEnvFile();
  for (const field of Object.keys(ENV_KEYS)) {
    const envValue = envCredential(field, fileEnv);
    if (envValue && toWrite[field] === envValue) toWrite[field] = null;
  }

  const tmpPath = `${CONFIG_PATH}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[imessage] Failed to save config: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/**
 * Watch config.json for changes.
 *
 * Watching the *file* does not work here. saveConfig() — and every editor
 * worth using — publishes changes by writing a temp file and renaming it over
 * the target. After the first such replace, the watch is still bound to the
 * old, now-unlinked inode, so every later save fires nothing. Measured
 * behaviour of the file-watch version: first save 1 event, every save after
 * that 0.
 *
 * So watch the *directory* and filter by filename instead. That survives
 * atomic replacement, and also catches the config file being created after
 * the daemon started, which the old `existsSync` guard silently skipped.
 *
 * Renames arrive as two events in quick succession on some platforms, so
 * reloads are debounced; a reload that throws must not kill the watcher.
 */
export function watchConfig(onChange, { debounceMs = 50 } = {}) {
  stopWatching();

  const targetName = path.basename(CONFIG_PATH);

  const reload = () => {
    watchDebounce = null;
    // A rename can briefly leave nothing at the path; loadConfig() already
    // falls back to defaults, which is not what a transient gap should mean.
    if (!fs.existsSync(CONFIG_PATH)) return;
    try {
      loadConfig();
      console.log('[imessage] Config file changed, reloading...');
      if (onChange) onChange(config);
    } catch (err) {
      console.error(`[imessage] Config reload failed: ${err.message}`);
    }
  };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    configWatcher = fs.watch(DATA_DIR, (eventType, filename) => {
      // filename can be null on some platforms; treat that as "might be ours".
      if (filename && filename !== targetName) return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(reload, debounceMs);
      watchDebounce.unref?.();
    });
    configWatcher.on('error', () => { configWatcher = null; });
  } catch {
    configWatcher = null;
  }
}

export function stopWatching() {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

/** Test seam: drop the module-level cache. */
export function resetConfigCache() {
  config = null;
}
