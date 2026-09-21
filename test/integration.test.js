/**
 * Integration tests for the main process.
 *
 * Everything else under test/ exercises a module in isolation; nothing loaded
 * src/index.js, so the parts that only exist there — the authorization gate on
 * the inbound path, self-message suppression, the reconnect supervisor and
 * shutdown — were never actually run by the suite. These tests spawn the real
 * entry point with:
 *
 *   - an isolated HOME, so config/spaces/socket all live in a temp dir;
 *   - the Photon SDK resolved to test/fixtures/stub-*.mjs via a loader hook;
 *   - a fake c4-receive.js that records every delivery attempt.
 *
 * The daemon itself is unmodified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ENTRY = path.join(REPO, 'src/index.js');
const LOADER = path.join(HERE, 'fixtures/stub-loader.mjs');

const OWNER = '+15555550100';
const STRANGER = '+15555550199';
const SECRET_BODY = 'meet me at the usual place';

/** A c4-receive.js stand-in: append the parsed call, answer ok. */
const FAKE_C4_RECEIVE = `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const call = {};
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i];
  if (!key.startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) { call[key.slice(2)] = true; continue; }
  call[key.slice(2)] = next;
  i += 1;
}
fs.appendFileSync(process.env.IMESSAGE_C4_LOG, JSON.stringify(call) + '\\n');
process.stdout.write(JSON.stringify({ ok: true }));
`;

function makeEnv(config, scenario) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-imessage-int-'));
  const dataDir = path.join(home, 'zylos/components/imessage');
  const c4Dir = path.join(home, 'zylos/.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(c4Dir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    projectId: 'stub-project',
    projectSecret: 'stub-secret',
    reconnect: { initialDelayMs: 50, maxDelayMs: 100 },
    ...config
  }, null, 2), { mode: 0o600 });

  fs.writeFileSync(path.join(c4Dir, 'c4-receive.js'), FAKE_C4_RECEIVE, { mode: 0o755 });

  const scenarioPath = path.join(home, 'scenario.json');
  const eventsPath = path.join(home, 'events.jsonl');
  const c4LogPath = path.join(home, 'c4.jsonl');
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario ?? { connections: [] }));
  fs.writeFileSync(eventsPath, '');
  fs.writeFileSync(c4LogPath, '');

  return { home, dataDir, scenarioPath, eventsPath, c4LogPath };
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function startDaemon(env) {
  const child = spawn(process.execPath, ['--import', LOADER, ENTRY], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME: env.home,
      IMESSAGE_STUB_SCENARIO: env.scenarioPath,
      IMESSAGE_STUB_EVENTS: env.eventsPath,
      IMESSAGE_C4_LOG: env.c4LogPath,
      // Keep the real ~/zylos/.env out of the picture.
      IMESSAGE_PROJECT_ID: '',
      IMESSAGE_PROJECT_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, exited, getOutput: () => output };
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = predicate(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopDaemon(daemon) {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return daemon.exited;
  daemon.child.kill('SIGTERM');
  return daemon.exited;
}

function dmFrom(senderId, text, { id = 'm1', direction = 'inbound', name = 'Somebody' } = {}) {
  return {
    space: { id: `any;-;${senderId}`, type: 'dm', phone: senderId },
    message: { id, direction, sender: { id: senderId, name }, content: { type: 'text', text } }
  };
}

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function setup(config, scenario) {
  const env = makeEnv(config, scenario);
  cleanups.push(env.home);
  return env;
}

// ---------------------------------------------------------------------------

test('a message from the owner is delivered to C4', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' } },
    { connections: [{ messages: [dmFrom(OWNER, 'hello there')], thenHang: true }] }
  );
  const daemon = startDaemon(env);
  try {
    const calls = await waitFor(
      () => { const c = readJsonl(env.c4LogPath); return c.length >= 1 ? c : false; },
      'the owner message to reach C4'
    );
    assert.equal(calls[0].channel, 'imessage');
    assert.match(calls[0].content, /hello there/);
    assert.match(calls[0].endpoint, /^any;-;\+15555550100\|type:dm/);
  } finally {
    await stopDaemon(daemon);
  }
});

test('a stranger DM is refused and never reaches C4', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' }, dmPolicy: 'owner' },
    {
      connections: [{
        messages: [dmFrom(STRANGER, SECRET_BODY, { id: 'm-stranger' })],
        thenHang: true
      }]
    }
  );
  const daemon = startDaemon(env);
  try {
    await waitFor(
      () => /Dropped message from/.test(daemon.getOutput()),
      'the daemon to report the drop'
    );
    // Give any (incorrect) delivery a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(readJsonl(env.c4LogPath), [], 'a stranger must not reach C4');
  } finally {
    await stopDaemon(daemon);
  }
});

test('no owner and no pairing code means nothing is delivered', async () => {
  const env = setup(
    { owner: { user_id: null }, pairing: { code: null } },
    { connections: [{ messages: [dmFrom(STRANGER, 'let me in')], thenHang: true }] }
  );
  const daemon = startDaemon(env);
  try {
    await waitFor(
      () => /owner not configured/.test(daemon.getOutput()),
      'the daemon to refuse an unowned DM'
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(readJsonl(env.c4LogPath), [], 'nothing may be delivered without an owner');

    const onDisk = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'config.json'), 'utf8'));
    assert.ok(!onDisk.owner?.user_id, 'the stranger must not have been bound as owner');
  } finally {
    await stopDaemon(daemon);
  }
});

test('the pairing code binds the owner without forwarding the code', async () => {
  const code = 'PAIR-12345678';
  const env = setup(
    { owner: { user_id: null }, pairing: { code, maxAttempts: 5 } },
    {
      connections: [{
        messages: [dmFrom(STRANGER, 'wrong guess', { id: 'm-bad' }), dmFrom(OWNER, code, { id: 'm-pair' })],
        thenHang: true
      }]
    }
  );
  const daemon = startDaemon(env);
  try {
    await waitFor(
      () => JSON.parse(fs.readFileSync(path.join(env.dataDir, 'config.json'), 'utf8')).owner?.user_id === OWNER,
      'the pairing code to bind the owner'
    );
    const onDisk = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'config.json'), 'utf8'));
    assert.equal(onDisk.pairing.code, null, 'the code must be consumed');

    // The notice is delivered through the same async path as any other
    // message, so wait for it rather than sampling the log immediately.
    await waitFor(
      () => readJsonl(env.c4LogPath).some((call) => call.endpoint === 'admin|type:owner-binding'),
      'the binding to be announced out of band'
    );

    const forwarded = readJsonl(env.c4LogPath).filter((call) => String(call.content).includes(code));
    assert.deepEqual(forwarded, [], 'the pairing code must never be forwarded to C4');
  } finally {
    await stopDaemon(daemon);
  }
});

test('our own outbound messages are not fed back into C4', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' } },
    {
      connections: [{
        messages: [
          dmFrom(OWNER, 'this is the agent talking', { id: 'm-out', direction: 'outbound' }),
          dmFrom(OWNER, 'this one is real', { id: 'm-in' })
        ],
        thenHang: true
      }]
    }
  );
  const daemon = startDaemon(env);
  try {
    const calls = await waitFor(
      () => { const c = readJsonl(env.c4LogPath); return c.length >= 1 ? c : false; },
      'the inbound message to reach C4'
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const all = readJsonl(env.c4LogPath);
    assert.equal(all.length, 1, 'exactly one delivery; the outbound echo must be suppressed');
    assert.match(all[0].content, /this one is real/);
    assert.ok(!all[0].content.includes('agent talking'));
    assert.ok(calls.length >= 1);
  } finally {
    await stopDaemon(daemon);
  }
});

test('a dropped stream reconnects and keeps delivering', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' } },
    {
      connections: [
        // First connection ends without warning.
        { messages: [], thenHang: false },
        // Second one carries the message.
        { messages: [dmFrom(OWNER, 'after reconnect', { id: 'm-2' })], thenHang: true }
      ]
    }
  );
  const daemon = startDaemon(env);
  try {
    await waitFor(
      () => readJsonl(env.eventsPath).filter((e) => e.event === 'connect').length >= 2,
      'a second connection attempt'
    );
    const calls = await waitFor(
      () => { const c = readJsonl(env.c4LogPath); return c.length >= 1 ? c : false; },
      'delivery after the reconnect'
    );
    assert.match(calls[0].content, /after reconnect/);
    assert.match(daemon.getOutput(), /Message stream ended unexpectedly/);
  } finally {
    await stopDaemon(daemon);
  }
});

test('a failed connection is retried with backoff', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' } },
    {
      connections: [
        { failConnect: 'photon unreachable' },
        { messages: [dmFrom(OWNER, 'recovered', { id: 'm-3' })], thenHang: true }
      ]
    }
  );
  const daemon = startDaemon(env);
  try {
    const calls = await waitFor(
      () => { const c = readJsonl(env.c4LogPath); return c.length >= 1 ? c : false; },
      'delivery after a failed connect'
    );
    assert.match(calls[0].content, /recovered/);
    assert.match(daemon.getOutput(), /Connection error: photon unreachable/);
  } finally {
    await stopDaemon(daemon);
  }
});

test('SIGTERM shuts down cleanly and removes the socket', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' } },
    { connections: [{ messages: [], thenHang: true }] }
  );
  const daemon = startDaemon(env);
  const socketPath = path.join(env.dataDir, 'ipc.sock');

  await waitFor(() => fs.existsSync(socketPath), 'the IPC socket to appear');
  await waitFor(() => /Listening for messages/.test(daemon.getOutput()), 'the daemon to connect');

  daemon.child.kill('SIGTERM');
  const { code } = await daemon.exited;

  assert.equal(code, 0, 'SIGTERM must be a clean exit');
  assert.match(daemon.getOutput(), /Shutting down \(SIGTERM\)/);
  assert.match(daemon.getOutput(), /Stopped\./);
  assert.equal(fs.existsSync(socketPath), false, 'the socket must not be left behind');
  assert.ok(
    readJsonl(env.eventsPath).some((e) => e.event === 'stop'),
    'the Photon client must be stopped'
  );
});

test('the daemon never writes message bodies or full numbers to its log', async () => {
  const env = setup(
    { owner: { user_id: OWNER, name: 'Owner' } },
    {
      connections: [{
        messages: [
          dmFrom(OWNER, SECRET_BODY, { id: 'm-a', name: 'Realname Person' }),
          dmFrom(OWNER, SECRET_BODY, { id: 'm-a', name: 'Realname Person' }),  // duplicate
          dmFrom(STRANGER, SECRET_BODY, { id: 'm-b', name: 'Realname Person' })
        ],
        thenHang: true
      }]
    }
  );
  const daemon = startDaemon(env);
  try {
    await waitFor(
      () => { const c = readJsonl(env.c4LogPath); return c.length >= 1; },
      'the owner message to reach C4'
    );
    await waitFor(() => /Duplicate message ignored/.test(daemon.getOutput()), 'the duplicate to be logged');
    await waitFor(() => /Dropped message from/.test(daemon.getOutput()), 'the stranger to be dropped');

    const log = daemon.getOutput();
    assert.ok(!log.includes(SECRET_BODY), 'the message body must not appear in the log');
    assert.ok(!log.includes(OWNER), 'the full owner number must not appear in the log');
    assert.ok(!log.includes(STRANGER), 'the full sender number must not appear in the log');
    assert.ok(!log.includes('Realname Person'), 'the contact name must not appear in the log');
    // It still has to be useful for diagnosis.
    assert.match(log, /\*\*\*0100/, 'a masked id should still be logged');
  } finally {
    await stopDaemon(daemon);
  }
});
