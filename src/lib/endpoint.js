/**
 * C4 endpoint id encoding.
 *
 * Shape: `<spaceId>|type:<dm|group>|msg:<messageId>|req:<correlationId>`
 *
 * Only `spaceId` is required to send — the daemon rebuilds the Space from it
 * via `imessage(spectrum).space.get(spaceId)`, so nothing else has to survive
 * across processes.
 */

/**
 * Only `%` and `|` are escaped, because `|` is the field separator and `%` is
 * the escape character. Everything else — including `;`, which real Photon
 * space ids contain (`any;-;+1555...`) — passes through untouched.
 *
 * This has to be *reversible*: a space id that does not survive the round trip
 * cannot be turned back into a Space, and every reply to that conversation
 * fails with "unknown space". An earlier version replaced anything outside a
 * narrow allowlist with `_`, which silently broke exactly that.
 */
export function safeId(raw) {
  return String(raw).replace(/%/g, '%25').replace(/\|/g, '%7C');
}

export function unsafeId(raw) {
  if (raw === null || raw === undefined) return raw;
  return String(raw).replace(/%7C/gi, '|').replace(/%25/g, '%');
}

export function buildEndpoint(spaceId, { type, messageId } = {}) {
  const parts = [safeId(spaceId)];
  if (type) parts.push(`type:${safeId(type)}`);
  if (messageId) {
    parts.push(`msg:${safeId(messageId)}`);
    parts.push(`req:${safeId(`${spaceId}:${messageId}`)}`);
  }
  return parts.join('|');
}

export function parseEndpoint(raw) {
  const result = { spaceId: null, type: null, msg: null, req: null };
  if (!raw || typeof raw !== 'string') return result;
  const parts = raw.split('|');
  result.spaceId = parts[0] ? unsafeId(parts[0]) : null;
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key in result) result[key] = unsafeId(value);
  }
  return result;
}
