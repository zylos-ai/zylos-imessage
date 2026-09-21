/**
 * Stand-in for `@spectrum-ts/core`.
 *
 * Shapes follow the published .d.ts (see workspace/photon-imessage-api-notes.md):
 * `Spectrum()` resolves to a client exposing an async-iterable `messages`,
 * `send()` and `stop()`; `text()` wraps a string as message content.
 */

import { record, nextConnection } from './stub-state.mjs';

export function text(body) {
  return { type: 'text', text: body };
}

export async function Spectrum({ projectId, projectSecret, providers, telemetry } = {}) {
  if (!projectId || !projectSecret) throw new Error('missing credentials');

  const plan = nextConnection();
  record({ event: 'connect', providers: (providers || []).length, telemetry: telemetry === true });

  if (plan.failConnect) {
    throw new Error(plan.failConnect === true ? 'stub connect failure' : String(plan.failConnect));
  }

  let stopped = false;
  let releaseHang = null;

  const messages = {
    async *[Symbol.asyncIterator]() {
      for (const entry of plan.messages || []) {
        if (stopped) return;
        const space = entry.space;
        const message = {
          ...entry.message,
          // The daemon calls read() as a best-effort receipt.
          read: async () => { record({ event: 'read', messageId: entry.message?.id ?? null }); }
        };
        yield [space, message];
      }
      if (stopped) return;
      if (plan.thenHang) {
        // Model a healthy, quiet connection: block until stop() is called.
        await new Promise((resolve) => { releaseHang = resolve; });
      }
      // Otherwise the iterator simply ends, which the daemon must treat as a
      // dropped stream and recover from.
      record({ event: 'stream-ended' });
    }
  };

  return {
    messages,
    async send(space, content) {
      record({ event: 'send', spaceId: space?.id ?? null, text: content?.text ?? null });
      return { id: `sent-${Math.floor(performance.now() * 1000)}` };
    },
    async stop() {
      stopped = true;
      record({ event: 'stop' });
      if (releaseHang) { releaseHang(); releaseHang = null; }
    }
  };
}
