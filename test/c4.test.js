import test from 'node:test';
import assert from 'node:assert/strict';

import { createC4Sender, parseC4Response, C4_RECEIVE } from '../src/lib/c4.js';

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
