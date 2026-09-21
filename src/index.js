#!/usr/bin/env node
/**
 * zylos-imessage — iMessage channel for Zylos agents, over Photon (Spectrum).
 *
 * Inbound:  spectrum.messages  ->  auth/dedupe/rate-limit  ->  c4-receive.js
 * Outbound: scripts/send.js    ->  unix socket             ->  spectrum.send
 *
 * The outbound hop goes through a socket because Photon only sends over the
 * SDK's long-lived connection, which lives here; see src/lib/ipc.js.
 */

import {
  getConfig, loadConfig, watchConfig, stopWatching,
  hasCredentials, repairConfigPermissions, DATA_DIR, CONFIG_PATH
} from './lib/config.js';
import { authorizeInbound, hasOwner } from './lib/auth.js';
import { createC4Sender } from './lib/c4.js';
import { createDeduper, createRateLimiter } from './lib/dedupe.js';
import { buildEndpoint } from './lib/endpoint.js';
import { startIpcServer, closeIpcServer, SOCKET_PATH } from './lib/ipc.js';
import { loadSpaces, saveSpaces, recordSpace } from './lib/spaces.js';
import {
  createSpectrumClient, extractText, describeNonText, describeSpace, describeSender
} from './lib/spectrum.js';

repairConfigPermissions();
let config = loadConfig();

console.log('[imessage] Starting...');
console.log(`[imessage] Data directory: ${DATA_DIR}`);

if (!config.enabled) {
  console.log('[imessage] Component disabled in config, exiting.');
  process.exit(0);
}

if (!hasCredentials(config)) {
  console.error('[imessage] Photon credentials missing.');
  console.error(`[imessage] Set projectId/projectSecret in ${CONFIG_PATH},`);
  console.error('[imessage] or IMESSAGE_PROJECT_ID / IMESSAGE_PROJECT_SECRET in ~/zylos/.env');
  process.exit(1);
}

// ============================================================
// Runtime state
// ============================================================

let stopped = false;
let client = null;          // { spectrum, im, text }
let ipcServer = null;
let reconnectTimer = null;
let spaces = loadSpaces();

const c4RetryTimers = new Set();
const sendToC4 = createC4Sender({ isStopped: () => stopped, retryTimers: c4RetryTimers });

const deduper = createDeduper({
  ttlMs: config.dedupe?.ttlMs,
  maxEntries: config.dedupe?.maxEntries
});
const rateLimiter = createRateLimiter({
  windowMs: config.rateLimit?.windowMs,
  max: config.rateLimit?.max
});
const rateLimitNotified = new Set();

const pruneInterval = setInterval(() => rateLimiter.prune(), 5 * 60 * 1000);
pruneInterval.unref?.();

// ============================================================
// Inbound
// ============================================================

function noteSpace(space, sender) {
  const { spaces: next, changed } = recordSpace(spaces, {
    id: space.id,
    type: space.type,
    phone: space.phone,
    name: sender?.name,
    seenAt: new Date().toISOString()
  });
  spaces = next;
  if (changed) saveSpaces(spaces);
}

function handleInbound(rawSpace, message) {
  if (stopped) return;

  // spectrum.messages surfaces our own sends too; only inbound is a user event.
  if (message?.direction && message.direction !== 'inbound') return;

  const space = describeSpace(rawSpace);
  if (!space.id) {
    console.warn('[imessage] Dropping message with no space id');
    return;
  }

  const dedupeKey = message?.id ? `${space.id}:${message.id}` : null;
  if (dedupeKey && deduper.isDuplicate(dedupeKey)) {
    console.log(`[imessage] Duplicate message ignored: ${dedupeKey}`);
    return;
  }

  const sender = describeSender(message, rawSpace);
  const hadOwner = hasOwner(config);
  const decision = authorizeInbound(config, {
    spaceId: space.id,
    spaceType: space.type,
    senderId: sender.id,
    senderName: sender.name
  });

  if (!decision.allowed) {
    console.log(`[imessage] Dropped message from ${sender.id || 'unknown'}: ${decision.reason}`);
    return;
  }

  if (!rateLimiter.allow(space.id)) {
    // One warning per space per window; the limiter itself does the dropping.
    if (!rateLimitNotified.has(space.id)) {
      rateLimitNotified.add(space.id);
      console.warn(`[imessage] Rate limit hit for space ${space.id}; dropping messages`);
      setTimeout(() => rateLimitNotified.delete(space.id), config.rateLimit?.windowMs || 60000).unref?.();
    }
    return;
  }

  noteSpace(space, sender);

  const body = extractText(message) || describeNonText(message);
  if (!body) {
    console.log('[imessage] Ignoring message with no renderable content');
    return;
  }

  const endpoint = buildEndpoint(space.id, { type: space.type, messageId: message?.id });
  const senderLabel = sender.name ? `${sender.name} (${sender.id})` : sender.id || 'unknown';
  const content = space.type === 'group'
    ? `[iMessage GROUP:${space.id}]\n${senderLabel} said: ${body}`
    : `[iMessage] ${senderLabel} said: ${body}`;

  sendToC4(endpoint, content);

  // Trust-on-first-use just happened. Say so loudly and out of band: the
  // binding is not identity-verified, and the operator needs to know.
  if (decision.boundOwner && !hadOwner) {
    const notice =
      `[imessage] Owner auto-bound to ${senderLabel} on first inbound DM ` +
      '(trust-on-first-use — NOT identity-verified). Confirm this is the intended ' +
      `owner, or correct "owner" in ${CONFIG_PATH}.`;
    console.warn(notice);
    sendToC4('admin|type:owner-binding', notice, { priority: 2, noReply: true });
  }

  // Best effort read receipt; never let it break the inbound path.
  Promise.resolve().then(() => message?.read?.()).catch(() => {});
}

// ============================================================
// Connection supervisor
// ============================================================

/**
 * The SDK's reconnect behaviour on a dropped stream is not something we have
 * been able to verify against the live service yet, so the iterator is wrapped
 * in our own supervisor with exponential backoff. Worst case that is redundant
 * with an SDK retry; best case it is the only thing keeping us online.
 */
async function runConnectionLoop() {
  let delay = config.reconnect?.initialDelayMs || 1000;
  const maxDelay = config.reconnect?.maxDelayMs || 60000;

  while (!stopped) {
    try {
      console.log('[imessage] Connecting to Photon...');
      client = await createSpectrumClient({
        projectId: config.projectId,
        projectSecret: config.projectSecret,
        logLevel: config.logLevel
      });
      console.log('[imessage] Connected. Listening for messages.');
      delay = config.reconnect?.initialDelayMs || 1000;

      for await (const [space, message] of client.spectrum.messages) {
        if (stopped) break;
        try {
          handleInbound(space, message);
        } catch (err) {
          // One malformed message must not tear down the stream.
          console.error(`[imessage] Error handling message: ${err.stack || err.message}`);
        }
      }

      if (stopped) break;
      console.warn('[imessage] Message stream ended unexpectedly.');
    } catch (err) {
      if (stopped) break;
      console.error(`[imessage] Connection error: ${err.message}`);
    }

    await shutdownClient();
    if (stopped) break;

    console.log(`[imessage] Reconnecting in ${delay}ms`);
    await sleepInterruptible(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

function sleepInterruptible(ms) {
  return new Promise((resolve) => {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      resolve();
    }, ms);
  });
}

async function shutdownClient() {
  if (!client) return;
  const current = client;
  client = null;
  try {
    await current.spectrum.stop();
  } catch (err) {
    console.warn(`[imessage] Error stopping Spectrum client: ${err.message}`);
  }
}

// ============================================================
// Outbound (IPC handler)
// ============================================================

async function handleIpcRequest(request) {
  const type = request?.type || 'send';

  if (type === 'ping') {
    return { ok: true, connected: Boolean(client), owner: config.owner?.user_id || null };
  }

  if (type !== 'send') {
    return { ok: false, error: `unknown request type: ${type}` };
  }

  const spaceId = request.spaceId ? String(request.spaceId) : null;
  const body = typeof request.text === 'string' ? request.text : '';
  if (!spaceId) return { ok: false, error: 'spaceId is required' };
  if (!body) return { ok: false, error: 'text is required' };
  if (!client) return { ok: false, error: 'not connected to Photon' };

  // A Space object is not portable across processes, but its id is — rebuild
  // it here from the id send.js parsed out of the C4 endpoint.
  const space = await client.im.space.get(spaceId);
  if (!space) return { ok: false, error: `unknown space: ${spaceId}` };

  const sent = await client.spectrum.send(space, client.text(body));
  return { ok: true, messageId: sent?.id ? String(sent.id) : null };
}

// ============================================================
// Lifecycle
// ============================================================

watchConfig((newConfig) => {
  const wasEnabled = config.enabled;
  config = newConfig;
  console.log('[imessage] Config reloaded');
  if (wasEnabled && !newConfig.enabled) {
    console.log('[imessage] Component disabled in config, stopping...');
    shutdown('config');
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  console.log(`[imessage] Shutting down (${signal})...`);

  stopWatching();
  clearInterval(pruneInterval);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  for (const timer of c4RetryTimers) clearTimeout(timer);
  c4RetryTimers.clear();

  await closeIpcServer(ipcServer, { socketPath: SOCKET_PATH });
  await shutdownClient();

  console.log('[imessage] Stopped.');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

async function main() {
  ipcServer = await startIpcServer(handleIpcRequest, { socketPath: SOCKET_PATH });
  console.log(`[imessage] IPC listening on ${SOCKET_PATH}`);
  await runConnectionLoop();
}

main().catch((err) => {
  console.error(`[imessage] Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
