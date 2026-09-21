import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEndpoint, parseEndpoint, safeId } from '../src/lib/endpoint.js';

test('buildEndpoint emits the space id alone when nothing else is known', () => {
  assert.equal(buildEndpoint('space-1'), 'space-1');
});

test('buildEndpoint adds type, message id and a derived correlation id', () => {
  assert.equal(
    buildEndpoint('space-1', { type: 'dm', messageId: 'msg-9' }),
    'space-1|type:dm|msg:msg-9|req:space-1:msg-9'
  );
});

test('parseEndpoint round-trips what buildEndpoint produced', () => {
  const endpoint = buildEndpoint('space-1', { type: 'group', messageId: 'msg-9' });
  assert.deepEqual(parseEndpoint(endpoint), {
    spaceId: 'space-1',
    type: 'group',
    msg: 'msg-9',
    req: 'space-1:msg-9'
  });
});

test('parseEndpoint tolerates a bare space id and junk input', () => {
  assert.equal(parseEndpoint('space-1').spaceId, 'space-1');
  assert.equal(parseEndpoint('').spaceId, null);
  assert.equal(parseEndpoint(null).spaceId, null);
  assert.equal(parseEndpoint('space-1|garbage|type:dm').type, 'dm');
});

test('parseEndpoint ignores keys that are not part of the schema', () => {
  const parsed = parseEndpoint('space-1|evil:1|type:dm');
  assert.equal(parsed.evil, undefined);
});

test('safeId escapes only the separator and the escape character', () => {
  // `|` splits fields and `%` is the escape, so only those two are encoded.
  assert.equal(safeId('a|b'), 'a%7Cb');
  assert.equal(safeId('100%'), '100%25');
  // Nothing else is touched: ids are keys, and a lossy transform would make
  // them unusable for space lookup. Values never reach a shell (execFile).
  assert.equal(safeId('+15555550142'), '+15555550142');
  assert.equal(safeId('user@example.com'), 'user@example.com');
  assert.equal(safeId('any;-;+15555550100'), 'any;-;+15555550100');
});

test('a real Photon space id survives the endpoint round trip', () => {
  // Regression: Photon ids look like `any;-;+1555...`. An earlier safeId
  // replaced `;` with `_`, so the id came back mangled and every reply to
  // that conversation failed with "unknown space".
  const spaceId = 'any;-;+15555550100';
  const parsed = parseEndpoint(buildEndpoint(spaceId, { type: 'dm', messageId: 'm1' }));
  assert.equal(parsed.spaceId, spaceId);
  assert.equal(parsed.type, 'dm');
});

test('an id containing the separator survives the round trip', () => {
  const spaceId = 'weird|id%with';
  assert.equal(parseEndpoint(buildEndpoint(spaceId, { type: 'dm' })).spaceId, spaceId);
});
