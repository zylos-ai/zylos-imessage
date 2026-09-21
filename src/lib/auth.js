/**
 * Access control for zylos-imessage.
 *
 * Mirrors the policy model the other Zylos channels use: an owner is bound
 * once, DMs are gated by `dmPolicy`, groups by `groupPolicy`.
 */

import { saveConfig } from './config.js';

export function hasOwner(config) {
  return Boolean(config.owner && config.owner.user_id);
}

export function isOwner(config, userId) {
  if (!hasOwner(config)) return false;
  return String(userId) === String(config.owner.user_id);
}

/**
 * Bind the owner. Rolls the in-memory config back if the write fails, so a
 * failed save can never leave us believing an unverified sender is the owner.
 *
 * @returns {boolean} true if bound and persisted
 */
export function bindOwner(config, userId, userName) {
  if (!userId) return false;
  const prevOwner = config.owner;
  const prevAllow = Array.isArray(config.dmAllowFrom) ? [...config.dmAllowFrom] : config.dmAllowFrom;

  config.owner = {
    user_id: String(userId),
    name: userName || null,
    bound_at: new Date().toISOString()
  };
  if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
  if (!config.dmAllowFrom.includes(String(userId))) config.dmAllowFrom.push(String(userId));

  if (!saveConfig(config)) {
    config.owner = prevOwner;
    config.dmAllowFrom = prevAllow;
    console.error('[imessage] Owner binding failed: config save error');
    return false;
  }
  console.log(`[imessage] Owner bound: ${userName || userId} (trust-on-first-use, identity NOT verified)`);
  return true;
}

export function isDmAllowed(config, userId) {
  if (isOwner(config, userId)) return true;
  const policy = config.dmPolicy || 'owner';
  if (policy === 'open') return true;
  if (policy === 'owner') return false;
  return (config.dmAllowFrom || []).map(String).includes(String(userId));
}

export function isGroupAllowed(config, spaceId) {
  const policy = config.groupPolicy || 'disabled';
  if (policy === 'disabled') return false;
  if (policy === 'open') return true;
  return Boolean(config.groups?.[String(spaceId)]);
}

export function isGroupSenderAllowed(config, spaceId, senderId) {
  if (isOwner(config, senderId)) return true;
  const allowFrom = config.groups?.[String(spaceId)]?.allowFrom;
  if (!Array.isArray(allowFrom) || allowFrom.length === 0 || allowFrom.includes('*')) return true;
  return allowFrom.map(String).includes(String(senderId));
}

export function getGroupName(config, spaceId, fallback) {
  return config.groups?.[String(spaceId)]?.name || fallback || 'group';
}

/**
 * Single decision point for "should this inbound message reach C4?".
 *
 * @returns {{allowed: boolean, reason?: string, boundOwner?: boolean}}
 */
export function authorizeInbound(config, { spaceId, spaceType, senderId, senderName }) {
  if (!spaceId) return { allowed: false, reason: 'missing space id' };

  if (spaceType === 'group') {
    if (!isGroupAllowed(config, spaceId)) return { allowed: false, reason: 'group not allowed' };
    if (!isGroupSenderAllowed(config, spaceId, senderId)) {
      return { allowed: false, reason: 'group sender not allowed' };
    }
    return { allowed: true };
  }

  // DM. With no owner yet, the first sender is bound trust-on-first-use — the
  // same model zalo uses. The caller is expected to surface that to the user
  // so the binding can be verified out of band.
  if (!hasOwner(config)) {
    const bound = bindOwner(config, senderId, senderName);
    if (!bound) return { allowed: false, reason: 'owner binding failed' };
    return { allowed: true, boundOwner: true };
  }

  if (!isDmAllowed(config, senderId)) return { allowed: false, reason: 'dm sender not allowed' };
  return { allowed: true };
}
