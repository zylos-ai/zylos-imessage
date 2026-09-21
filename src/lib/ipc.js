/**
 * Unix-domain-socket IPC between the daemon and short-lived `scripts/send.js`
 * invocations.
 *
 * Why this exists: Photon has no outbound REST API — sending goes through the
 * SDK's long-lived gRPC connection, which belongs to the daemon. But C4 sends
 * by spawning `scripts/send.js <endpoint> <message>`, a process that lives for
 * one message. Building a second Spectrum client per send would be slow (it
 * fetches project metadata on init) and risks counting as an extra "server"
 * against the project quota. So send.js just hands the work to the daemon.
 *
 * Protocol: one newline-delimited JSON request per connection, one
 * newline-delimited JSON response back, then close.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

export const SOCKET_PATH = path.join(DATA_DIR, 'ipc.sock');
const MAX_FRAME_BYTES = 1024 * 1024; // a single iMessage cannot legitimately approach this

/**
 * Is something already listening on `socketPath`?
 * Distinguishes a live daemon from a socket file left behind by a crash.
 */
export function probeSocket(socketPath = SOCKET_PATH, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const socket = net.connect(socketPath);
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Start the IPC server.
 *
 * @param {(request: object) => Promise<object>} handler
 * @returns {Promise<import('node:net').Server>}
 */
export async function startIpcServer(handler, { socketPath = SOCKET_PATH } = {}) {
  const alive = await probeSocket(socketPath);
  if (alive) {
    throw new Error(`Another zylos-imessage daemon is already listening on ${socketPath}`);
  }
  // Only safe to remove now that we know nothing answers on it.
  try { fs.unlinkSync(socketPath); } catch {}
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = net.createServer((socket) => {
    let buffer = '';
    let handled = false;

    const respond = (payload) => {
      if (handled) return;
      handled = true;
      try {
        socket.end(JSON.stringify(payload) + '\n');
      } catch {
        socket.destroy();
      }
    };

    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => respond({ ok: false, error: 'ipc request timed out' }));
    socket.on('error', () => { handled = true; });

    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        respond({ ok: false, error: 'request too large' });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        respond({ ok: false, error: 'malformed JSON request' });
        return;
      }

      Promise.resolve()
        .then(() => handler(request))
        .then(result => respond(result ?? { ok: true }))
        .catch(err => respond({ ok: false, error: err?.message || String(err) }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Owner-only: anyone who can write here can send messages as us.
  try { fs.chmodSync(socketPath, 0o600); } catch {}

  return server;
}

export function closeIpcServer(server, { socketPath = SOCKET_PATH } = {}) {
  return new Promise((resolve) => {
    if (!server) {
      try { fs.unlinkSync(socketPath); } catch {}
      resolve();
      return;
    }
    server.close(() => {
      try { fs.unlinkSync(socketPath); } catch {}
      resolve();
    });
  });
}

/**
 * Client side: send one request, await one response.
 *
 * @returns {Promise<object>} the daemon's parsed response
 */
export function ipcRequest(request, { socketPath = SOCKET_PATH, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`IPC request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    socket.setEncoding('utf8');
    socket.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        finish(new Error(`zylos-imessage daemon is not running (${socketPath})`));
        return;
      }
      finish(err);
    });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (err) {
        finish(new Error(`malformed IPC response: ${err.message}`));
      }
    });
    socket.on('end', () => {
      if (settled) return;
      // Server closed without a complete frame — tolerate a missing trailing
      // newline rather than failing a send that may already have gone out.
      const trimmed = buffer.trim();
      if (!trimmed) {
        finish(new Error('daemon closed the connection without responding'));
        return;
      }
      try {
        finish(null, JSON.parse(trimmed));
      } catch (err) {
        finish(new Error(`malformed IPC response: ${err.message}`));
      }
    });
  });
}
