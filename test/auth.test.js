import test from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome, readConfig, cleanup } from './helpers.js';

const HOME = useTempHome();
const { loadConfig, resetConfigCache } = await import('../src/lib/config.js');
const auth = await import('../src/lib/auth.js');

test.after(() => cleanup(HOME));

function freshConfig(overrides = {}) {
  resetConfigCache();
  return { ...loadConfig(), owner: { user_id: null, name: null, bound_at: null }, ...overrides };
}

test('dmPolicy owner blocks everyone but the owner', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' }, dmPolicy: 'owner' });
  assert.equal(auth.isDmAllowed(cfg, 'u1'), true);
  assert.equal(auth.isDmAllowed(cfg, 'u2'), false);
});

test('dmPolicy open lets anyone through', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' }, dmPolicy: 'open' });
  assert.equal(auth.isDmAllowed(cfg, 'stranger'), true);
});

test('dmPolicy allowlist honours dmAllowFrom', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' }, dmPolicy: 'allowlist', dmAllowFrom: ['u2'] });
  assert.equal(auth.isDmAllowed(cfg, 'u2'), true);
  assert.equal(auth.isDmAllowed(cfg, 'u3'), false);
});

test('group policy defaults to disabled', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' } });
  assert.equal(auth.isGroupAllowed(cfg, 'g1'), false);
});

test('group allowlist requires an explicit entry', () => {
  const cfg = freshConfig({
    owner: { user_id: 'u1' }, groupPolicy: 'allowlist', groups: { g1: { name: 'G' } }
  });
  assert.equal(auth.isGroupAllowed(cfg, 'g1'), true);
  assert.equal(auth.isGroupAllowed(cfg, 'g2'), false);
});

test('group sender allowlist gates non-owners but never the owner', () => {
  const cfg = freshConfig({
    owner: { user_id: 'u1' },
    groupPolicy: 'allowlist',
    groups: { g1: { name: 'G', allowFrom: ['u2'] } }
  });
  assert.equal(auth.isGroupSenderAllowed(cfg, 'g1', 'u2'), true);
  assert.equal(auth.isGroupSenderAllowed(cfg, 'g1', 'u3'), false);
  assert.equal(auth.isGroupSenderAllowed(cfg, 'g1', 'u1'), true);
  // A wildcard or an empty list means "anyone in the allowlisted group".
  cfg.groups.g1.allowFrom = ['*'];
  assert.equal(auth.isGroupSenderAllowed(cfg, 'g1', 'u3'), true);
});

test('a stranger cannot become owner just by messaging first', () => {
  const cfg = freshConfig();
  const result = auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: '+15555550100', senderName: 'Stranger', text: 'hello'
  });
  assert.equal(result.allowed, false, 'must not be delivered');
  assert.ok(!result.boundOwner, 'must not bind');
  assert.equal(auth.hasOwner(cfg), false);
  assert.match(result.reason, /owner not configured/);
});

test('with no owner and no pairing code, every DM is dropped', () => {
  const cfg = freshConfig({ pairing: { code: null } });
  for (const text of ['hi', '', 'password', 'ZYLOS-123456']) {
    const result = auth.authorizeInbound(cfg, {
      spaceId: 's1', spaceType: 'dm', senderId: '+15555550100', text
    });
    assert.equal(result.allowed, false);
    assert.equal(auth.hasOwner(cfg), false);
  }
});

test('a pairing code that is too short is refused outright', () => {
  const cfg = freshConfig({ pairing: { code: 'short' } });
  assert.equal(auth.pairingState(cfg).usable, false);
  const result = auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: '+15555550100', text: 'short'
  });
  assert.equal(result.allowed, false);
  assert.equal(auth.hasOwner(cfg), false, 'a weak code must never bind an owner');
});

test('an expired pairing code cannot bind', () => {
  const cfg = freshConfig({
    pairing: { code: 'PAIR-12345678', expiresAt: '2000-01-01T00:00:00.000Z' }
  });
  const result = auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: '+15555550100', text: 'PAIR-12345678'
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /expired/);
  assert.equal(auth.hasOwner(cfg), false);
});

test('the correct pairing code binds the owner but withholds the message', () => {
  auth.resetPairingAttempts();
  const cfg = freshConfig({ pairing: { code: 'PAIR-12345678', maxAttempts: 5 } });
  const result = auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: '+15555550100', senderName: 'Bobo',
    text: '  PAIR-12345678  '
  });

  assert.equal(result.boundOwner, true);
  assert.equal(result.allowed, false, 'the body is the secret and must not be forwarded');
  assert.equal(cfg.owner.user_id, '+15555550100');

  const onDisk = readConfig(HOME);
  assert.equal(onDisk.owner.user_id, '+15555550100', 'binding must survive a restart');
  assert.equal(onDisk.pairing.code, null, 'the code must be consumed by the same write');
});

test('a consumed pairing code cannot be replayed to rebind someone else', () => {
  auth.resetPairingAttempts();
  const cfg = freshConfig({ pairing: { code: 'PAIR-12345678', maxAttempts: 5 } });
  assert.equal(auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: 'first', text: 'PAIR-12345678'
  }).boundOwner, true);

  const replay = auth.authorizeInbound(cfg, {
    spaceId: 's2', spaceType: 'dm', senderId: 'attacker', text: 'PAIR-12345678'
  });
  assert.equal(replay.allowed, false);
  assert.ok(!replay.boundOwner);
  assert.equal(cfg.owner.user_id, 'first', 'owner must be unchanged');
});

test('pairing attempts are capped', () => {
  auth.resetPairingAttempts();
  const cfg = freshConfig({ pairing: { code: 'PAIR-12345678', maxAttempts: 3 } });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(auth.authorizeInbound(cfg, {
      spaceId: 's1', spaceType: 'dm', senderId: 'attacker', text: `guess-${i}`
    }).allowed, false);
  }
  assert.equal(auth.getPairingAttempts(), 3);
  // Budget spent: even the right code is refused now.
  const result = auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: 'attacker', text: 'PAIR-12345678'
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /too many failed pairing attempts/);
  assert.equal(auth.hasOwner(cfg), false);
  auth.resetPairingAttempts();
});

test('authorizeInbound rejects a second sender once an owner exists', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' }, dmPolicy: 'owner' });
  const result = auth.authorizeInbound(cfg, { spaceId: 's1', spaceType: 'dm', senderId: 'u2' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not allowed/);
});

test('authorizeInbound rejects group traffic while groups are disabled', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' } });
  const result = auth.authorizeInbound(cfg, { spaceId: 'g1', spaceType: 'group', senderId: 'u1' });
  assert.equal(result.allowed, false);
});

test('authorizeInbound rejects a message with no space id', () => {
  const cfg = freshConfig({ owner: { user_id: 'u1' } });
  assert.equal(auth.authorizeInbound(cfg, { spaceType: 'dm', senderId: 'u1' }).allowed, false);
});

test('bindOwner refuses an empty user id', () => {
  const cfg = freshConfig();
  assert.equal(auth.bindOwner(cfg, null, 'nobody'), false);
  assert.equal(auth.hasOwner(cfg), false);
});
