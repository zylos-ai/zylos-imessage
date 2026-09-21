import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { useTempHome, cleanup } from './helpers.js';

const HOME = useTempHome();
const { loadSpaces, saveSpaces, recordSpace, SPACES_PATH } = await import('../src/lib/spaces.js');

test.after(() => cleanup(HOME));

test('loadSpaces returns an empty map when nothing has been stored', () => {
  assert.deepEqual(loadSpaces(), {});
});

test('recordSpace stores a new space and reports the change', () => {
  const { spaces, changed } = recordSpace({}, {
    id: 's1', type: 'dm', phone: '+6512345678', name: 'Bobo', seenAt: '2026-09-21T00:00:00Z'
  });
  assert.equal(changed, true);
  assert.equal(spaces.s1.phone, '+6512345678');
  assert.equal(spaces.s1.firstSeen, '2026-09-21T00:00:00Z');
});

test('re-seeing an unchanged space only bumps lastSeen', () => {
  let spaces = recordSpace({}, { id: 's1', type: 'dm', phone: 'p', name: 'n', seenAt: 't1' }).spaces;
  const second = recordSpace(spaces, { id: 's1', type: 'dm', phone: 'p', name: 'n', seenAt: 't2' });
  assert.equal(second.changed, false, 'no rewrite needed for an unchanged space');
  assert.equal(second.spaces.s1.lastSeen, 't2');
  assert.equal(second.spaces.s1.firstSeen, 't1');
});

test('a changed display name is detected', () => {
  const spaces = recordSpace({}, { id: 's1', type: 'dm', name: 'old', seenAt: 't1' }).spaces;
  assert.equal(recordSpace(spaces, { id: 's1', type: 'dm', name: 'new', seenAt: 't2' }).changed, true);
});

test('a missing field does not erase what we already knew', () => {
  const spaces = recordSpace({}, { id: 's1', type: 'dm', phone: 'p', name: 'n', seenAt: 't1' }).spaces;
  const next = recordSpace(spaces, { id: 's1', seenAt: 't2' }).spaces;
  assert.equal(next.s1.phone, 'p');
  assert.equal(next.s1.name, 'n');
});

test('recordSpace ignores an entry with no id', () => {
  const { spaces, changed } = recordSpace({}, { seenAt: 't' });
  assert.equal(changed, false);
  assert.deepEqual(spaces, {});
});

test('the registry is bounded, evicting least-recently-seen entries', () => {
  let spaces = {};
  for (let i = 0; i < 520; i++) {
    spaces = recordSpace(spaces, { id: `s${i}`, type: 'dm', seenAt: String(i).padStart(4, '0') }).spaces;
  }
  const keys = Object.keys(spaces);
  assert.ok(keys.length <= 500, `expected <=500 entries, got ${keys.length}`);
  assert.ok(!keys.includes('s0'), 'oldest entry should have been evicted');
  assert.ok(keys.includes('s519'), 'newest entry must be kept');
});

test('spaces survive a save/load round-trip at 0600', () => {
  const spaces = recordSpace({}, { id: 's1', type: 'dm', phone: 'p', seenAt: 't' }).spaces;
  assert.equal(saveSpaces(spaces), true);
  assert.equal(fs.statSync(SPACES_PATH).mode & 0o777, 0o600);
  assert.deepEqual(loadSpaces(), spaces);
});

test('a corrupt spaces file degrades to empty instead of throwing', () => {
  fs.writeFileSync(SPACES_PATH, '[1,2,3]');
  assert.deepEqual(loadSpaces(), {});
  fs.writeFileSync(SPACES_PATH, 'not json');
  assert.deepEqual(loadSpaces(), {});
});
