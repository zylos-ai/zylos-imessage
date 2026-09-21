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

test('authorizeInbound binds the first DM sender as owner and persists it', () => {
  const cfg = freshConfig();
  const result = auth.authorizeInbound(cfg, {
    spaceId: 's1', spaceType: 'dm', senderId: '+6512345678', senderName: 'Bobo'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.boundOwner, true);
  assert.equal(cfg.owner.user_id, '+6512345678');
  assert.equal(readConfig(HOME).owner.user_id, '+6512345678', 'binding must survive a restart');
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
