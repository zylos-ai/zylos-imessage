/**
 * Exercises scripts/send.js as C4 actually invokes it: a real child process,
 * argv/stdin input, talking to a stand-in daemon over the unix socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { useTempHome, writeConfig, cleanup } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEND_JS = path.join(__dirname, '../scripts/send.js');

const HOME = useTempHome();
const SOCK = path.join(HOME, 'zylos/components/imessage/ipc.sock');

writeConfig(HOME, { message: { maxLength: 40, chunkDelayMs: 0 }, ipc: { requestTimeoutMs: 3000 } });

test.after(() => cleanup(HOME));

/** Stand-in daemon: collects requests, replies with whatever `reply` returns. */
async function withFakeDaemon(reply, fn) {
  const received = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      received.push(req);
      socket.end(JSON.stringify(reply(req, received.length)) + '\n');
    });
  });
  try { fs.unlinkSync(SOCK); } catch {}
  await new Promise(r => server.listen(SOCK, r));
  try {
    return await fn(received);
  } finally {
    await new Promise(r => server.close(r));
    try { fs.unlinkSync(SOCK); } catch {}
  }
}

function runSend(args, { stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEND_JS, ...args], {
      env: { ...process.env, HOME },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function receipt(stdout) {
  const line = stdout.split('\n').find(l => l.startsWith('RECEIPT '));
  return line ? JSON.parse(line.slice('RECEIPT '.length)) : null;
}

test('a short message is delivered and acknowledged', async () => {
  await withFakeDaemon(
    () => ({ ok: true, messageId: 'm1' }),
    async (received) => {
      const res = await runSend(['space-1|type:dm|msg:9|req:space-1:9', 'hello there']);
      assert.equal(res.code, 0, res.stderr);
      assert.deepEqual(received, [{ type: 'send', spaceId: 'space-1', text: 'hello there' }]);

      const r = receipt(res.stdout);
      assert.equal(r.status, 'sent');
      assert.equal(r.spaceId, 'space-1');
      assert.equal(r.correlationId, 'space-1:9');
      assert.deepEqual(r.messageIds, ['m1']);
      assert.equal(r.chunks, 1);
    }
  );
});

test('the message can arrive on stdin instead of argv', async () => {
  await withFakeDaemon(
    () => ({ ok: true, messageId: 'm1' }),
    async (received) => {
      const res = await runSend(['space-1'], { stdin: 'from stdin\n' });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(received[0].text, 'from stdin');
    }
  );
});

test('markdown is stripped before it reaches the chat', async () => {
  await withFakeDaemon(
    () => ({ ok: true }),
    async (received) => {
      await runSend(['space-1', '**bold** text']);
      assert.equal(received[0].text, 'bold text');
    }
  );
});

test('a long message is split across several sends', async () => {
  await withFakeDaemon(
    (req, n) => ({ ok: true, messageId: `m${n}` }),
    async (received) => {
      const res = await runSend(['space-1', 'word '.repeat(40).trim()]);
      assert.equal(res.code, 0, res.stderr);
      assert.ok(received.length > 1, 'expected multiple chunks');
      for (const req of received) assert.ok(req.text.length <= 40);
      const r = receipt(res.stdout);
      assert.equal(r.chunks, received.length);
      assert.equal(r.messageIds.length, received.length);
    }
  );
});

test('[SKIP] sends nothing and still exits clean', async () => {
  await withFakeDaemon(
    () => ({ ok: true }),
    async (received) => {
      const res = await runSend(['space-1', '[SKIP]']);
      assert.equal(res.code, 0);
      assert.equal(received.length, 0);
      assert.equal(receipt(res.stdout).status, 'skipped');
    }
  );
});

test('a daemon-side rejection fails the send with its reason', async () => {
  await withFakeDaemon(
    () => ({ ok: false, error: 'unknown space: space-1' }),
    async () => {
      const res = await runSend(['space-1', 'hello']);
      assert.equal(res.code, 1);
      const r = receipt(res.stdout);
      assert.equal(r.status, 'failed');
      assert.match(r.error, /unknown space/);
    }
  );
});

test('a partial multi-chunk failure reports the chunks that did land', async () => {
  await withFakeDaemon(
    (req, n) => (n === 1 ? { ok: true, messageId: 'm1' } : { ok: false, error: 'link down' }),
    async () => {
      const res = await runSend(['space-1', 'word '.repeat(40).trim()]);
      assert.equal(res.code, 1);
      const r = receipt(res.stdout);
      assert.equal(r.status, 'failed');
      assert.deepEqual(r.messageIds, ['m1'], 'the delivered chunk must be reported');
      assert.match(r.error, /link down/);
    }
  );
});

test('with no daemon running the send fails loudly', async () => {
  try { fs.unlinkSync(SOCK); } catch {}
  const res = await runSend(['space-1', 'hello']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /daemon is not running/);
});

test('media is refused rather than posted as a raw marker', async () => {
  await withFakeDaemon(
    () => ({ ok: true }),
    async (received) => {
      const res = await runSend(['space-1', '[MEDIA:image]/tmp/x.png']);
      assert.equal(res.code, 1);
      assert.equal(received.length, 0);
      assert.match(receipt(res.stdout).error, /not implemented/);
    }
  );
});

test('an endpoint with no space id is rejected before any work', async () => {
  const res = await runSend(['', 'hello']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing space id/);
});

test('an empty message is rejected', async () => {
  await withFakeDaemon(
    () => ({ ok: true }),
    async (received) => {
      const res = await runSend(['space-1'], { stdin: '   ' });
      assert.equal(res.code, 1);
      assert.equal(received.length, 0);
      assert.match(res.stderr, /no message provided/);
    }
  );
});

test('no arguments prints usage and exits non-zero', async () => {
  const res = await runSend([]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage/);
});
