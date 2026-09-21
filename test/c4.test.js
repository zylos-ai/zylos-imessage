import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createC4Sender, parseC4Response, describeExecFailure, C4_RECEIVE } from '../src/lib/c4.js';

function argsToObject(args) {
  const out = { script: args[0], flags: {} };
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    }
  }
  return out;
}

test('parseC4Response tolerates junk', () => {
  assert.equal(parseC4Response(''), null);
  assert.equal(parseC4Response('not json'), null);
  assert.deepEqual(parseC4Response(' {"ok":true} '), { ok: true });
});

test('sendToC4 invokes c4-receive with the expected flags', () => {
  let seen = null;
  const send = createC4Sender({ exec: (bin, args, opts, cb) => { seen = args; cb(null, '{"ok":true}'); } });
  send('space-1|type:dm', 'hello');

  const parsed = argsToObject(seen);
  assert.equal(parsed.script, C4_RECEIVE);
  assert.equal(parsed.flags.channel, 'imessage');
  assert.equal(parsed.flags.endpoint, 'space-1|type:dm');
  assert.equal(parsed.flags.content, 'hello');
  assert.equal(parsed.flags.json, true);
});

test('sendToC4 passes priority and no-reply when asked', () => {
  let seen = null;
  const send = createC4Sender({ exec: (bin, args, opts, cb) => { seen = args; cb(null, '{"ok":true}'); } });
  send('admin|type:owner-binding', 'notice', { priority: 2, noReply: true });

  const parsed = argsToObject(seen);
  assert.equal(parsed.flags.priority, '2');
  assert.equal(parsed.flags['no-reply'], true);
});

test('sendToC4 drops empty content and does nothing while stopped', () => {
  let calls = 0;
  const exec = (bin, args, opts, cb) => { calls++; cb(null, '{"ok":true}'); };
  createC4Sender({ exec })('e', '');
  createC4Sender({ exec, isStopped: () => true })('e', 'hello');
  assert.equal(calls, 0);
});

test('an explicit C4 rejection is reported and never retried', async () => {
  let calls = 0;
  let rejectedWith = null;
  const send = createC4Sender({
    retryDelayMs: 5,
    exec: (bin, args, opts, cb) => {
      calls++;
      cb(new Error('exit 1'), '{"ok":false,"error":{"code":"BLOCKED","message":"policy"}}');
    }
  });
  send('e', 'hello', { onReject: (m) => { rejectedWith = m; } });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(calls, 1, 'a policy refusal must not be retried');
  assert.equal(rejectedWith, 'policy');
});

test('a transport failure is retried exactly once', async () => {
  let calls = 0;
  let failed = false;
  const send = createC4Sender({
    retryDelayMs: 5,
    exec: (bin, args, opts, cb) => { calls++; cb(new Error('ECONNREFUSED'), ''); }
  });
  send('e', 'hello', { onFail: () => { failed = true; } });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(calls, 2);
  assert.equal(failed, true);
});

test('a retry that succeeds reports no failure', async () => {
  let calls = 0;
  let failed = false;
  const send = createC4Sender({
    retryDelayMs: 5,
    exec: (bin, args, opts, cb) => {
      calls++;
      if (calls === 1) cb(new Error('transient'), '');
      else cb(null, '{"ok":true}');
    }
  });
  send('e', 'hello', { onFail: () => { failed = true; } });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(calls, 2);
  assert.equal(failed, false);
});

// --- failure logging must not leak the endpoint or the body ----------------
//
// The regression these cover: sanitizeExecError() trimmed execFile's message
// from `--content` onwards, which dropped the body but kept the head — and the
// head contains `--endpoint <space id>`, where a real Photon space id embeds
// the phone number. Both failure paths wrote that head to out.log.

/** Shaped like a real Photon space id, with a documentation-only number. */
const SPACE_ID = 'any;-;+15555550100|type:dm';
const BODY = 'synthetic-body-must-never-be-logged';

/**
 * A genuine execFile failure that never reaches C4: only args[0] (the script
 * path) is swapped for a throwaway that exits 1, so every flag we build —
 * `--endpoint <space id>`, `--content <body>` — still lands on the real
 * command line that Node copies into error.message.
 */
function realFailingExec() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-imessage-execfail-'));
  const script = path.join(dir, 'exit1.js');
  fs.writeFileSync(script, "process.stderr.write('boom\\n');\nprocess.exit(1);\n");
  return {
    exec: (bin, args, opts, cb) => execFile(bin, [script, ...args.slice(1)], opts, cb),
    dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

function captureConsole() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => lines.push(args.join(' '));
  }
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => Object.assign(console, original)
  };
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

function assertNoPersonalData(text, where) {
  assert.ok(!text.includes('+15555550100'), `${where} leaked the full number: ${text}`);
  assert.ok(!text.includes(BODY), `${where} leaked the message body: ${text}`);
  assert.ok(!text.includes('--content'), `${where} echoed the command line: ${text}`);
  assert.ok(!text.includes('--endpoint'), `${where} echoed the command line: ${text}`);
}

test('a first delivery failure logs neither the number nor the body', async () => {
  const { exec, dispose } = realFailingExec();
  const retryTimers = new Set();
  const cap = captureConsole();
  let text = '';
  try {
    // Long retry delay: this asserts on the first-failure line alone.
    const send = createC4Sender({ exec, retryDelayMs: 60000, retryTimers });
    send(SPACE_ID, BODY);
    await waitFor(() => cap.lines.some(l => l.includes('retrying in')));
    text = cap.text();
  } finally {
    cap.restore();
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.clear();
    dispose();
  }

  assert.match(text, /C4 delivery to .* failed/, 'the failure must still be reported');
  assertNoPersonalData(text, 'first-failure log');
  assert.ok(text.includes('***0100|type:dm'), `destination must stay identifiable but masked: ${text}`);
  assert.ok(text.includes('code=1'), `exit status must survive redaction: ${text}`);
});

test('a retry failure logs neither the number nor the body', async () => {
  const { exec, dispose } = realFailingExec();
  const retryTimers = new Set();
  const cap = captureConsole();
  let text = '';
  try {
    const send = createC4Sender({ exec, retryDelayMs: 5, retryTimers });
    send(SPACE_ID, BODY);
    await waitFor(() => cap.lines.some(l => l.includes('after retry')));
    text = cap.text();
  } finally {
    cap.restore();
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.clear();
    dispose();
  }

  assert.match(text, /failed after retry/, 'the final failure must still be reported');
  assertNoPersonalData(text, 'retry-failure log');
  assert.ok(text.includes('***0100|type:dm'), `destination must stay identifiable but masked: ${text}`);
});

test('describeExecFailure reports status without quoting the command', () => {
  const error = Object.assign(new Error(`Command failed: node script --endpoint ${SPACE_ID} --content ${BODY}`), {
    code: 1,
    cmd: `node script --endpoint ${SPACE_ID} --content ${BODY}`
  });
  const described = describeExecFailure(error);
  assertNoPersonalData(described, 'describeExecFailure');
  assert.equal(described, 'name=Error code=1');

  assert.equal(describeExecFailure(null), 'unknown error');
  assert.equal(
    describeExecFailure(Object.assign(new Error('x'), { code: 'ENOENT' })),
    'name=Error code=ENOENT'
  );
  assert.equal(
    describeExecFailure(Object.assign(new Error('x'), { signal: 'SIGTERM', killed: true })),
    'name=Error signal=SIGTERM killed=true'
  );
});

test('pending retries are tracked so shutdown can cancel them', async () => {
  const retryTimers = new Set();
  let calls = 0;
  const send = createC4Sender({
    retryDelayMs: 1000,
    retryTimers,
    exec: (bin, args, opts, cb) => { calls++; cb(new Error('transient'), ''); }
  });
  send('e', 'hello');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(retryTimers.size, 1);
  for (const t of retryTimers) clearTimeout(t);
  retryTimers.clear();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(calls, 1, 'cancelled retry must not fire');
});
