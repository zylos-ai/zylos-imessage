import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { useTempHome, readConfig, cleanup } from './helpers.js';

const HOME = useTempHome();
const config = await import('../src/lib/config.js');

const HOOK = fileURLToPath(new URL('../hooks/configure.js', import.meta.url));
const CONFIG_FILE = path.join(HOME, 'zylos/components/imessage/config.json');

test.after(() => cleanup(HOME));

/** Run the configure hook with `collected` on stdin, against the temp HOME. */
function runHook(collected) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(collected),
    env: { ...process.env, HOME },
    encoding: 'utf8'
  });
}

function removeConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
}

test('configure hook writes keys the config loader actually reads', () => {
  removeConfig();
  runHook({
    IMESSAGE_PROJECT_ID: 'pid-abc',
    IMESSAGE_PROJECT_SECRET: 'sec-xyz'
  });

  // The regression this guards: a mechanical prefix-strip + lowercase wrote
  // `project_id`, which loadConfig() never looks at, so the daemon started up
  // with no credentials and no error.
  const onDisk = readConfig(HOME);
  assert.equal(onDisk.projectId, 'pid-abc');
  assert.equal(onDisk.projectSecret, 'sec-xyz');
  assert.ok(!('project_id' in onDisk), 'must not write snake_case keys');

  config.resetConfigCache();
  assert.equal(config.hasCredentials(config.loadConfig()), true);
});

test('configure hook writes config.json 0600 inside a 0700 data dir', () => {
  removeConfig();
  runHook({ IMESSAGE_PROJECT_SECRET: 'sec-xyz' });

  // config.json can hold the project secret, so group/other access is a leak.
  assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(CONFIG_FILE)).mode & 0o777, 0o700);
});

test('configure hook preserves existing config and ignores unknown keys', () => {
  removeConfig();
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ enabled: true, dmPolicy: 'open', projectId: 'old' }, null, 2),
    { mode: 0o600 }
  );

  runHook({ IMESSAGE_PROJECT_ID: 'new', IMESSAGE_NOT_A_REAL_KEY: 'junk' });

  const onDisk = readConfig(HOME);
  assert.equal(onDisk.projectId, 'new', 'collected value should win');
  assert.equal(onDisk.dmPolicy, 'open', 'unrelated existing setting should survive');
  assert.ok(!('notARealKey' in onDisk), 'unknown keys must be dropped, not guessed at');
  assert.ok(!('IMESSAGE_NOT_A_REAL_KEY' in onDisk));
});

test('configure hook treats an empty value as "not supplied"', () => {
  removeConfig();
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ enabled: true, projectId: 'keep-me' }, null, 2),
    { mode: 0o600 }
  );

  // Credentials may already live in the environment, so the installer can
  // legitimately collect nothing for them. That must not blank the config.
  runHook({ IMESSAGE_PROJECT_ID: '', IMESSAGE_PROJECT_SECRET: null });

  assert.equal(readConfig(HOME).projectId, 'keep-me');
});

test('configure hook rejects malformed stdin instead of writing a bad config', () => {
  removeConfig();
  assert.throws(() => execFileSync('node', [HOOK], {
    input: '[]',
    env: { ...process.env, HOME },
    encoding: 'utf8',
    stdio: 'pipe'
  }));
  assert.equal(fs.existsSync(CONFIG_FILE), false);
});
