/**
 * Inbound dedupe and per-space rate limiting.
 *
 * `now` is injectable so tests do not have to sleep.
 */

export function createDeduper({ ttlMs = 5 * 60 * 1000, maxEntries = 1000, now = Date.now } = {}) {
  const seen = new Map(); // key -> expiry timestamp

  function dropExpired(ts) {
    for (const [key, expiry] of seen) {
      if (expiry <= ts) seen.delete(key);
    }
  }

  function enforceCap() {
    // Map preserves insertion order, so the front is the oldest.
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  return {
    /** Records `key` and reports whether it had already been seen. */
    isDuplicate(key) {
      if (!key) return false;
      const ts = now();
      dropExpired(ts);
      if (seen.has(key)) return true;
      seen.set(key, ts + ttlMs);
      // Cap is enforced after the insert, otherwise the map would be allowed
      // to sit one entry above maxEntries.
      enforceCap();
      return false;
    },
    get size() { return seen.size; },
    clear() { seen.clear(); }
  };
}

export function createRateLimiter({ windowMs = 60 * 1000, max = 60, now = Date.now } = {}) {
  const hits = new Map(); // key -> timestamps[]

  return {
    /** @returns {boolean} true when the call is within budget. */
    allow(key = 'global') {
      const ts = now();
      const cutoff = ts - windowMs;
      const recent = (hits.get(key) || []).filter(t => t > cutoff);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(ts);
      hits.set(key, recent);
      return true;
    },
    /** Drop keys with no activity in the current window. */
    prune() {
      const cutoff = now() - windowMs;
      for (const [key, times] of hits) {
        const recent = times.filter(t => t > cutoff);
        if (recent.length === 0) hits.delete(key);
        else hits.set(key, recent);
      }
    },
    get size() { return hits.size; },
    clear() { hits.clear(); }
  };
}
