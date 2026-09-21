/**
 * Outbound text shaping: iMessage renders plain text, so markdown is stripped,
 * and long replies are split on natural boundaries.
 */

export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, (match) => match.slice(3, -3).replace(/^\w*\n/, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s/gm, '- ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

/**
 * Split `text` into chunks of at most `maxLen`, preferring paragraph, then
 * line, then word boundaries — but only when the boundary is late enough in
 * the chunk that we are not wasting most of it.
 */
export function splitMessage(text, maxLen) {
  if (!Number.isInteger(maxLen) || maxLen <= 0) throw new Error('maxLen must be a positive integer');
  if (text.length <= maxLen) return text.length ? [text] : [];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      const tail = remaining.trim();
      if (tail) chunks.push(tail);
      break;
    }

    let breakAt = maxLen;
    const window = remaining.substring(0, maxLen);
    const lastPara = window.lastIndexOf('\n\n');
    if (lastPara > maxLen * 0.3) {
      breakAt = lastPara + 1;
    } else {
      const lastNewline = window.lastIndexOf('\n');
      if (lastNewline > maxLen * 0.3) {
        breakAt = lastNewline;
      } else {
        const lastSpace = window.lastIndexOf(' ');
        if (lastSpace > maxLen * 0.3) breakAt = lastSpace;
      }
    }

    const part = remaining.substring(0, breakAt).trim();
    const rest = remaining.substring(breakAt).trim();
    // Guard against a boundary that consumes nothing (e.g. leading whitespace
    // run) — without this a pathological input would loop forever.
    if (rest.length >= remaining.length) {
      chunks.push(remaining.substring(0, maxLen).trim());
      remaining = remaining.substring(maxLen).trim();
      continue;
    }
    if (part) chunks.push(part);
    remaining = rest;
  }
  return chunks;
}

/** Apply the configured outbound shaping in one call. */
export function prepareOutbound(text, { maxLength = 2000, stripMarkdown: strip = true } = {}) {
  const body = strip ? stripMarkdown(text) : text;
  return splitMessage(body, maxLength);
}
