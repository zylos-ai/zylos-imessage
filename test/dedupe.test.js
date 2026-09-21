import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeduper, createRateLimiter } from '../src/lib/dedupe.js';

test('deduper reports the second sighting of a key', () => {
  const d = createDeduper();
  assert.equal(d.isDuplicate('a'), false);
  assert.equal(d.isDuplicate('a'), true);
  assert.equal(d.isDuplicate('b'), false);
});

test('deduper ignores empty keys rather than collapsing them together', () => {
  const d = createDeduper();
  assert.equal(d.isDuplicate(null), false);
  assert.equal(d.isDuplicate(null), false);
  assert.equal(d.size, 0);
});

test('deduper forgets keys once the TTL passes', () => {
  let now = 1000;
  const d = createDeduper({ ttlMs: 500, now: () => now });
  assert.equal(d.isDuplicate('a'), false);
  now = 1400;
  assert.equal(d.isDuplicate('a'), true);
  now = 2000;
  assert.equal(d.isDuplicate('a'), false);
});

test('deduper evicts the oldest entries past maxEntries', () => {
  let now = 0;
  const d = createDeduper({ maxEntries: 3, ttlMs: 10_000, now: () => now++ });
  for (const key of ['a', 'b', 'c', 'd', 'e']) d.isDuplicate(key);
  assert.ok(d.size <= 3);
  assert.equal(d.isDuplicate('e'), true, 'most recent key should still be known');
});

test('rate limiter allows up to max within the window then blocks', () => {
  let now = 0;
  const r = createRateLimiter({ windowMs: 1000, max: 3, now: () => now });
  assert.equal(r.allow('s'), true);
  assert.equal(r.allow('s'), true);
  assert.equal(r.allow('s'), true);
  assert.equal(r.allow('s'), false);
});

test('rate limiter budgets each key independently', () => {
  const r = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
  assert.equal(r.allow('a'), true);
  assert.equal(r.allow('b'), true);
  assert.equal(r.allow('a'), false);
});

test('rate limiter recovers after the window slides', () => {
  let now = 0;
  const r = createRateLimiter({ windowMs: 1000, max: 1, now: () => now });
  assert.equal(r.allow('s'), true);
  assert.equal(r.allow('s'), false);
  now = 1500;
  assert.equal(r.allow('s'), true);
});

test('rate limiter prune drops keys that went quiet', () => {
  let now = 0;
  const r = createRateLimiter({ windowMs: 1000, max: 5, now: () => now });
  r.allow('s');
  assert.equal(r.size, 1);
  now = 5000;
  r.prune();
  assert.equal(r.size, 0);
});
