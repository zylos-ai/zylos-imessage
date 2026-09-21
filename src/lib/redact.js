/**
 * Log redaction.
 *
 * Everything this component handles is personal data: the sender id is a phone
 * number or Apple ID, the display name is a real name, and the body is private
 * correspondence. Logs here go to pm2's out.log, which has no retention policy
 * and is readable by anything that can read the data dir — so the rule is that
 * message bodies and contact names never reach a log line at all, and ids are
 * reduced to the minimum needed to correlate two lines about the same person.
 *
 * Diagnosing a delivery problem needs "which conversation", not "which words".
 */

/** Mask all but the last 4 characters: `+15555550100` -> `***0100`. */
export function redactId(value) {
  if (value === null || value === undefined) return 'unknown';
  const str = String(value);
  if (!str) return 'unknown';
  if (str.length <= 4) return '***';
  return `***${str.slice(-4)}`;
}

/**
 * A sender label safe to log. The display name is dropped entirely — it is a
 * real person's name and adds nothing a masked id does not already give us.
 */
export function redactSender(sender) {
  return redactId(sender?.id);
}

/**
 * Mask a C4 endpoint for logging. Real Photon space ids embed the phone
 * number (`any;-;+1555...`), so the id itself is personal data; only the
 * structural `type:` field is kept intact.
 */
export function redactEndpoint(endpoint) {
  if (!endpoint) return 'unknown';
  return String(endpoint)
    .split('|')
    .map((part, index) => {
      if (index === 0) return redactId(part);
      const sep = part.indexOf(':');
      if (sep <= 0) return redactId(part);
      const key = part.slice(0, sep);
      if (key === 'type') return part;
      return `${key}:${redactId(part.slice(sep + 1))}`;
    })
    .join('|');
}

/**
 * Describe a message without quoting it. Length and kind are enough to tell an
 * empty message from a dropped one, or text from an attachment.
 */
export function describeBody(body, kind = 'text') {
  if (!body) return 'empty';
  return `${kind}, ${String(body).length} chars`;
}
