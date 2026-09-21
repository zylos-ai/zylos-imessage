import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { useTempHome, writeConfig, readConfig, cleanup } from './helpers.js';

// config.js reads HOME at module load, so the temp home must be in place first.
const HOME = useTempHome();
const config = await import('../src/lib/config.js');

test.after(() => cleanup(HOME));

test('loadConfig falls back to defaults when the file is absent', () => {
  config.resetConfigCache();
  const cfg = config.loadConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.dmPolicy, 'owner');
  assert.equal(cfg.groupPolicy, 'disabled');
  assert.equal(cfg.owner.user_id, null);
});

test('loadConfig deep-merges nested sections instead of replacing them', () => {
  writeConfig(HOME, { message: { maxLength: 500 } });
  config.resetConfigCache();
  const cfg = config.loadConfig();
  assert.equal(cfg.message.maxLength, 500);
  assert.equal(cfg.message.stripMarkdown, true, 'sibling default should survive');
  fs.unlinkSync(config.CONFIG_PATH);
});

test('loadConfig survives a corrupt config file', () => {
  fs.writeFileSync(config.CONFIG_PATH, '{not json');
  config.resetConfigCache();
  const cfg = config.loadConfig();
  assert.equal(cfg.enabled, true);
  fs.unlinkSync(config.CONFIG_PATH);
});

test('credentials fall back to process.env', () => {
  process.env.IMESSAGE_PROJECT_ID = 'env-pid';
  process.env.IMESSAGE_PROJECT_SECRET = 'env-secret';
  config.resetConfigCache();
  const cfg = config.loadConfig();
  assert.equal(cfg.projectId, 'env-pid');
  assert.equal(config.hasCredentials(cfg), true);
  delete process.env.IMESSAGE_PROJECT_ID;
  delete process.env.IMESSAGE_PROJECT_SECRET;
});

test('config.json credentials win over the environment', () => {
  process.env.IMESSAGE_PROJECT_ID = 'env-pid';
  writeConfig(HOME, { projectId: 'file-pid', projectSecret: 'file-secret' });
  config.resetConfigCache();
  const cfg = config.loadConfig();
  assert.equal(cfg.projectId, 'file-pid');
  delete process.env.IMESSAGE_PROJECT_ID;
  fs.unlinkSync(config.CONFIG_PATH);
});

test('credentials fall back to ~/zylos/.env', () => {
  fs.writeFileSync(
    path.join(HOME, 'zylos/.env'),
    '# comment\nIMESSAGE_PROJECT_ID="dotenv-pid"\nIMESSAGE_PROJECT_SECRET=dotenv-secret\nJUNK\n'
  );
  config.resetConfigCache();
  const cfg = config.loadConfig();
  assert.equal(cfg.projectId, 'dotenv-pid');
  assert.equal(cfg.projectSecret, 'dotenv-secret');
});

test('hasCredentials requires both halves', () => {
  assert.equal(config.hasCredentials({ projectId: 'a', projectSecret: null }), false);
  assert.equal(config.hasCredentials({ projectId: null, projectSecret: 'b' }), false);
  assert.equal(config.hasCredentials({ projectId: 'a', projectSecret: 'b' }), true);
});

test('saveConfig does not copy env-sourced credentials into config.json', () => {
  config.resetConfigCache();
  const cfg = config.loadConfig();          // picks up dotenv-pid from ~/zylos/.env
  assert.equal(cfg.projectId, 'dotenv-pid');
  cfg.dmPolicy = 'open';
  assert.equal(config.saveConfig(cfg), true);

  const onDisk = readConfig(HOME);
  assert.equal(onDisk.dmPolicy, 'open');
  assert.equal(onDisk.projectId, null, 'env-sourced id must not be duplicated to disk');
  assert.equal(onDisk.projectSecret, null, 'env-sourced secret must not be duplicated to disk');
  fs.unlinkSync(path.join(HOME, 'zylos/.env'));
});

test('saveConfig writes config.json at 0600', () => {
  config.resetConfigCache();
  const cfg = config.loadConfig();
  cfg.projectSecret = 'literal-secret';
  config.saveConfig(cfg);
  const mode = fs.statSync(config.CONFIG_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.equal(readConfig(HOME).projectSecret, 'literal-secret');
});

test('repairConfigPermissions tightens a world-readable config', () => {
  fs.chmodSync(config.CONFIG_PATH, 0o644);
  assert.equal(config.repairConfigPermissions(), true);
  assert.equal(fs.statSync(config.CONFIG_PATH).mode & 0o777, 0o600);
  // Already tight: nothing to do.
  assert.equal(config.repairConfigPermissions(), false);
});

test('readEnvFile returns empty for a missing file', () => {
  assert.deepEqual(config.readEnvFile(path.join(HOME, 'nope.env')), {});
});

// --- hot reload -----------------------------------------------------------
//
// The bug these cover: watching the config *file* binds to an inode, and
// saveConfig publishes via rename. The first atomic replace unlinks the
// watched inode, so every save after it fired nothing.

/** Resolve once `onChange` has fired, or reject after `timeoutMs`. */
function nextReload(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('config reload did not fire')), timeoutMs);
    pendingReload = (cfg) => { clearTimeout(timer); resolve(cfg); };
  });
}

let pendingReload = null;

test('config reload fires on every atomic replace, not just the first', async () => {
  writeConfig(HOME, { dmPolicy: 'owner' });
  config.resetConfigCache();
  config.loadConfig();
  config.watchConfig((cfg) => { if (pendingReload) { const fn = pendingReload; pendingReload = null; fn(cfg); } });

  try {
    // Three consecutive rename-based saves. The pre-fix watcher saw only #1.
    for (const policy of ['open', 'allowlist', 'owner']) {
      const waiter = nextReload();
      const cfg = { ...config.getConfig(), dmPolicy: policy };
      assert.equal(config.saveConfig(cfg), true);
      const reloaded = await waiter;
      assert.equal(reloaded.dmPolicy, policy, `save to "${policy}" must reach the daemon`);
    }

    // An in-place append (what a plain editor without atomic-save does) too.
    const waiter = nextReload();
    const onDisk = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));
    onDisk.dmPolicy = 'open';
    fs.writeFileSync(config.CONFIG_PATH, JSON.stringify(onDisk, null, 2));
    assert.equal((await waiter).dmPolicy, 'open');
  } finally {
    config.stopWatching();
    pendingReload = null;
  }
});

test('a corrupt write during reload leaves the last good config in place', async () => {
  writeConfig(HOME, { dmPolicy: 'allowlist' });
  config.resetConfigCache();
  config.loadConfig();
  config.watchConfig((cfg) => { if (pendingReload) { const fn = pendingReload; pendingReload = null; fn(cfg); } });

  try {
    const waiter = nextReload();
    fs.writeFileSync(config.CONFIG_PATH, '{ not json');
    // The watcher must still fire (and not throw); loadConfig falls back to
    // defaults for an unparseable file rather than leaving a half-read state.
    const reloaded = await waiter;
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.dmPolicy, 'owner', 'falls back to the safe default');
  } finally {
    config.stopWatching();
    pendingReload = null;
  }
});

test('stopWatching ends delivery', async () => {
  writeConfig(HOME, { dmPolicy: 'owner' });
  config.resetConfigCache();
  config.loadConfig();
  let fired = 0;
  config.watchConfig(() => { fired += 1; });
  config.stopWatching();

  config.saveConfig({ ...config.getConfig(), dmPolicy: 'open' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fired, 0);
});
