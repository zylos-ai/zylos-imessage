#!/usr/bin/env node
/**
 * C4 outbound interface for zylos-imessage.
 *
 * Usage:
 *   node scripts/send.js <endpoint_id> "message text"
 *   echo "message text" | node scripts/send.js <endpoint_id>
 *
 * This process does not talk to Photon. It hands the message to the running
 * daemon over a unix socket, which owns the SDK connection (see src/lib/ipc.js
 * for why). If the daemon is down, the send fails loudly rather than silently
 * dropping the reply.
 *
 * Exit codes:
 *   0 - Success (or an explicit [SKIP])
 *   1 - Error (message printed to stderr)
 */

import { loadConfig } from '../src/lib/config.js';
import { parseEndpoint } from '../src/lib/endpoint.js';
import { prepareOutbound } from '../src/lib/format.js';
import { ipcRequest, SOCKET_PATH } from '../src/lib/ipc.js';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: send.js <endpoint_id> [message]');
  console.error('       echo "message" | send.js <endpoint_id>');
  process.exit(1);
}

const endpointRaw = args[0];
const cliMessage = args.slice(1).join(' ');

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Machine-parseable delivery receipt for C4 correlation. */
function emitReceipt({ status, messageIds = [], chunks, error }, { spaceId, correlationId }) {
  const receipt = { status, type: 'text', spaceId, correlationId, messageIds, ts: Date.now() };
  if (chunks !== undefined) receipt.chunks = chunks;
  if (error) receipt.error = error;
  console.log('RECEIPT ' + JSON.stringify(receipt));
}

async function main() {
  const parsed = parseEndpoint(endpointRaw);
  const spaceId = parsed.spaceId;
  const correlationId = parsed.req || null;

  if (!spaceId) {
    console.error('Error: invalid endpoint (missing space id)');
    process.exit(1);
  }

  const config = loadConfig();
  const stdinData = await readStdin(cliMessage ? 100 : 5000);
  const message = stdinData.trim() || cliMessage;

  if (!message) {
    console.error('Error: no message provided');
    process.exit(1);
  }

  if (message.trim() === '[SKIP]') {
    emitReceipt({ status: 'skipped' }, { spaceId, correlationId });
    console.log('Skipped (smart mode)');
    return;
  }

  if (message.startsWith('[MEDIA:')) {
    // Attachments go through a different Content type in the SDK; not wired up
    // yet. Fail explicitly instead of posting the raw marker to the chat.
    const error = 'media sending is not implemented for iMessage yet';
    emitReceipt({ status: 'failed', error }, { spaceId, correlationId });
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  const chunks = prepareOutbound(message, config.message || {});
  const timeoutMs = config.ipc?.requestTimeoutMs || 30000;
  const chunkDelayMs = config.message?.chunkDelayMs ?? 600;
  const messageIds = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const response = await ipcRequest(
        { type: 'send', spaceId, text: chunks[i] },
        { socketPath: SOCKET_PATH, timeoutMs }
      );
      if (!response?.ok) {
        throw new Error(response?.error || 'daemon rejected the send');
      }
      if (response.messageId) messageIds.push(response.messageId);
      console.log(`Sent chunk ${i + 1}/${chunks.length}`);
      if (i < chunks.length - 1) await sleep(chunkDelayMs);
    }
  } catch (err) {
    const error = err?.message || String(err);
    // Report how many chunks did land — a partial send is not a no-op, and
    // whoever reads this needs to know before retrying.
    emitReceipt(
      { status: 'failed', messageIds, chunks: chunks.length, error },
      { spaceId, correlationId }
    );
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  emitReceipt({ status: 'sent', messageIds, chunks: chunks.length }, { spaceId, correlationId });
  console.log('Message sent successfully');
}

main().catch((err) => {
  console.error(`Error: ${err?.message || err}`);
  process.exit(1);
});
