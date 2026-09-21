/**
 * C4 inbound bridge.
 *
 * Messages are handed to comm-bridge's c4-receive.js. A transport failure gets
 * one retry; an explicit rejection (`ok: false`) does not, because retrying a
 * policy refusal just produces the same refusal.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export const C4_RECEIVE = path.join(
  process.env.HOME,
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js'
);

const EXEC_OPTS = { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 };

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
        console.log(`[imessage] -> C4: ${content.slice(0, 60).replace(/\n/g, ' ')}`);
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
      console.warn(`[imessage] C4 delivery failed, retrying in ${retryDelayMs}ms: ${error.message}`);

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
          console.error(`[imessage] C4 delivery failed after retry: ${retryError.message}`);
          if (onFail) onFail(retryError);
        });
      }, retryDelayMs);
      retryTimers.add(timer);
    });
  };
}
