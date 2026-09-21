/**
 * C4 inbound bridge.
 *
 * Messages are handed to comm-bridge's c4-receive.js. A transport failure gets
 * one retry; an explicit rejection (`ok: false`) does not, because retrying a
 * policy refusal just produces the same refusal.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

import { redactEndpoint } from './redact.js';

export const C4_RECEIVE = path.join(
  process.env.HOME,
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js'
);

const EXEC_OPTS = { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 };

/**
 * execFile's failure message is `Command failed: <file> <args...>`, and our
 * args end with `--content <the entire message body>`. Logging it raw would
 * put the full body in out.log — worse than the 60-char excerpt this file
 * used to print. Everything from `--content` on is dropped.
 */
export function sanitizeExecError(error) {
  const message = error?.message ? String(error.message) : 'unknown error';
  const cut = message.indexOf('--content');
  const head = cut === -1 ? message : `${message.slice(0, cut)}--content <redacted>`;
  // stderr is appended after the command line; keep its tail, minus any body.
  return head.split('\n')[0].trim();
}

export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {() => boolean} deps.isStopped  suppresses retries during shutdown
 * @param {Set<NodeJS.Timeout>} deps.retryTimers  so shutdown can clear them
 * @param {Function} [deps.exec]  injectable execFile, for tests
 */
export function createC4Sender({ isStopped = () => false, retryTimers = new Set(), exec = execFile, retryDelayMs = 2000 } = {}) {
  return function sendToC4(endpoint, content, { channel = 'imessage', priority, noReply = false, onReject, onFail } = {}) {
    if (!content || isStopped()) return;

    const args = [C4_RECEIVE, '--channel', channel, '--endpoint', endpoint, '--json'];
    if (priority) args.push('--priority', String(priority));
    if (noReply) args.push('--no-reply');
    args.push('--content', content);

    exec(process.execPath, args, EXEC_OPTS, (error, stdout) => {
      if (!error) {
        // Never log the body. See src/lib/redact.js: out.log has no retention
        // policy, and an excerpt of a private message is still a private
        // message. Size and destination are what a delivery problem needs.
        console.log(`[imessage] -> C4: delivered to ${redactEndpoint(endpoint)} (${content.length} chars)`);
        return;
      }

      const response = parseC4Response(stdout);
      if (response?.ok === false) {
        const message = response.error?.message || 'rejected';
        console.warn(`[imessage] C4 rejected (${response.error?.code || 'unknown'}): ${message}`);
        if (onReject) onReject(message);
        return;
      }

      if (isStopped()) return;
      console.warn(`[imessage] C4 delivery failed, retrying in ${retryDelayMs}ms: ${sanitizeExecError(error)}`);

      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (isStopped()) return;
        exec(process.execPath, args, EXEC_OPTS, (retryError, retryStdout) => {
          if (!retryError || isStopped()) return;
          const retryResponse = parseC4Response(retryStdout);
          if (retryResponse?.ok === false) {
            if (onReject) onReject(retryResponse.error?.message || 'rejected');
            return;
          }
          console.error(`[imessage] C4 delivery failed after retry: ${sanitizeExecError(retryError)}`);
          if (onFail) onFail(retryError);
        });
      }, retryDelayMs);
      retryTimers.add(timer);
    });
  };
}
