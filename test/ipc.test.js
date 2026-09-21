import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { useTempHome, cleanup } from './helpers.js';

const HOME = useTempHome();
const ipc = await import('../src/lib/ipc.js');

const SOCK = path.join(HOME, 'zylos/components/imessage/test.sock');

test.after(() => cleanup(HOME));

async function withServer(handler, fn) {
  const server = await ipc.startIpcServer(handler, { socketPath: SOCK });
  try {
    await fn(server);
  } finally {
    await ipc.closeIpcServer(server, { socketPath: SOCK });
  }
}

test('request and response round-trip over the socket', async () => {
  await withServer(
    async (req) => ({ ok: true, echo: req.text }),
    async () => {
      const res = await ipcRequest({ type: 'send', text: 'hi' });
      assert.deepEqual(res, { ok: true, echo: 'hi' });
    }
  );
});

function ipcRequest(payload, opts = {}) {
  return ipc.ipcRequest(payload, { socketPath: SOCK, timeoutMs: 2000, ...opts });
}

test('the socket is created owner-only', async () => {
  await withServer(async () => ({ ok: true }), async () => {
    const mode = fs.statSync(SOCK).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

test('closeIpcServer removes the socket file', async () => {
  const server = await ipc.startIpcServer(async () => ({ ok: true }), { socketPath: SOCK });
  assert.equal(fs.existsSync(SOCK), true);
  await ipc.closeIpcServer(server, { socketPath: SOCK });
  assert.equal(fs.existsSync(SOCK), false);
});

test('a handler that throws becomes an error response, not a hang', async () => {
  await withServer(
    async () => { throw new Error('boom'); },
    async () => {
      const res = await ipcRequest({ type: 'send' });
      assert.deepEqual(res, { ok: false, error: 'boom' });
    }
  );
});

test('malformed JSON is rejected without killing the server', async () => {
  await withServer(async () => ({ ok: true }), async () => {
    const res = await new Promise((resolve, reject) => {
      const socket = net.connect(SOCK);
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write('{not json\n'));
      socket.on('data', (c) => { buf += c; });
      socket.on('end', () => resolve(JSON.parse(buf.trim())));
      socket.on('error', reject);
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /malformed JSON/);

    // Server is still usable afterwards.
    assert.deepEqual(await ipcRequest({ type: 'send' }), { ok: true });
  });
});

test('an oversized frame is refused', async () => {
  await withServer(async () => ({ ok: true }), async () => {
    const res = await new Promise((resolve, reject) => {
      const socket = net.connect(SOCK);
      let buf = '';
      socket.setEncoding('utf8');
      // No newline, so the server must cut us off on size alone.
      socket.on('connect', () => socket.write('x'.repeat(1024 * 1024 + 10)));
      socket.on('data', (c) => { buf += c; });
      socket.on('end', () => resolve(JSON.parse(buf.trim())));
      socket.on('error', reject);
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /too large/);
  });
});

test('probeSocket distinguishes a live server from a stale socket file', async () => {
  assert.equal(await ipc.probeSocket(SOCK), false);
  await withServer(async () => ({ ok: true }), async () => {
    assert.equal(await ipc.probeSocket(SOCK), true);
  });
  // Leave a stale file behind, as a crash would.
  fs.writeFileSync(SOCK, '');
  assert.equal(await ipc.probeSocket(SOCK), false);
  fs.unlinkSync(SOCK);
});

test('startIpcServer reclaims a stale socket file', async () => {
  fs.writeFileSync(SOCK, '');
  await withServer(async () => ({ ok: true, reclaimed: true }), async () => {
    assert.deepEqual(await ipcRequest({ type: 'send' }), { ok: true, reclaimed: true });
  });
});

test('startIpcServer refuses to displace a live daemon', async () => {
  await withServer(async () => ({ ok: true }), async () => {
    await assert.rejects(
      () => ipc.startIpcServer(async () => ({ ok: true }), { socketPath: SOCK }),
      /already listening/
    );
    // The original server must still be serving.
    assert.deepEqual(await ipcRequest({ type: 'send' }), { ok: true });
  });
});

test('a client gets a clear error when no daemon is running', async () => {
  await assert.rejects(
    () => ipcRequest({ type: 'send' }),
    /daemon is not running/
  );
});

test('a client times out rather than hanging on a silent server', async () => {
  await withServer(
    () => new Promise(() => {}),   // never resolves
    async () => {
      await assert.rejects(() => ipcRequest({ type: 'send' }, { timeoutMs: 150 }), /timed out/);
    }
  );
});

test('a response without a trailing newline is still parsed', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', () => socket.end('{"ok":true,"partial":1}'));
  });
  const raw = path.join(HOME, 'zylos/components/imessage/raw.sock');
  await new Promise(r => server.listen(raw, r));
  try {
    const res = await ipc.ipcRequest({ type: 'send' }, { socketPath: raw, timeoutMs: 2000 });
    assert.deepEqual(res, { ok: true, partial: 1 });
  } finally {
    await new Promise(r => server.close(r));
    try { fs.unlinkSync(raw); } catch {}
  }
});

test('a server that closes without responding surfaces an error', async () => {
  const server = net.createServer((socket) => socket.on('data', () => socket.end()));
  const raw = path.join(HOME, 'zylos/components/imessage/silent.sock');
  await new Promise(r => server.listen(raw, r));
  try {
    await assert.rejects(
      () => ipc.ipcRequest({ type: 'send' }, { socketPath: raw, timeoutMs: 2000 }),
      /without responding/
    );
  } finally {
    await new Promise(r => server.close(r));
    try { fs.unlinkSync(raw); } catch {}
  }
});
