/**
 * Access control for zylos-imessage.
 *
 * Mirrors the policy model the other Zylos channels use: an owner is bound
 * once, DMs are gated by `dmPolicy`, groups by `groupPolicy`.
 *
 * The owner is NEVER inferred from traffic. Photon's iMessage number is
 * shared, so "whoever messaged first" is not an identity claim — it is just
 * whoever happened to message first, including a stranger or a wrong number.
 * An owner is therefore either pre-bound in config.json, or bound by a sender
 * who proves possession of a pairing code shared out of band. Until then every
 * DM is dropped without being forwarded.
 */

import { timingSafeEqual } from 'node:crypto';

import { saveConfig } from './config.js';

/** A pairing code below this length is not a meaningful secret; we refuse it. */
export const MIN_PAIRING_CODE_LENGTH = 8;

/**
 * Failed pairing attempts, per process. Deliberately not persisted: writing to
 * disk on every bad guess would hand an unauthenticated sender a way to churn
 * the config file. The inbound rate limiter is the other half of this defence.
 */
let pairingAttempts = 0;

/** Test seam. */
export function resetPairingAttempts() {
  pairingAttempts = 0;
}

export function getPairingAttempts() {
  return pairingAttempts;
}

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
 * Callers must have established that `userId` is entitled to be the owner.
 * The only in-band caller is the pairing-code path below; everything else
 * binds by editing config.json.
 *
 * @returns {boolean} true if bound and persisted
 */
export function bindOwner(config, userId, userName, { consumePairingCode = false } = {}) {
  if (!userId) return false;
  const prevOwner = config.owner;
  const prevAllow = Array.isArray(config.dmAllowFrom) ? [...config.dmAllowFrom] : config.dmAllowFrom;
  const prevPairing = config.pairing ? { ...config.pairing } : config.pairing;

  config.owner = {
    user_id: String(userId),
    name: userName || null,
    bound_at: new Date().toISOString()
  };
  if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
  if (!config.dmAllowFrom.includes(String(userId))) config.dmAllowFrom.push(String(userId));
  // A pairing code is single-use: burn it in the same write that binds the
  // owner, so a replay of the same code can never rebind to someone else.
  if (consumePairingCode && config.pairing) config.pairing = { ...config.pairing, code: null };

  if (!saveConfig(config)) {
    config.owner = prevOwner;
    config.dmAllowFrom = prevAllow;
    config.pairing = prevPairing;
    console.error('[imessage] Owner binding failed: config save error');
    return false;
  }
  return true;
}

/**
 * Is a pairing code currently usable? A code that is missing, too short, or
 * past its expiry is treated as absent rather than as an error, so a stale
 * entry left in config.json cannot quietly re-open binding.
 */
export function pairingState(config, now = Date.now()) {
  const code = config.pairing?.code;
  if (!code || typeof code !== 'string') return { usable: false, reason: 'no pairing code' };
  if (code.trim().length < MIN_PAIRING_CODE_LENGTH) {
    return { usable: false, reason: `pairing code shorter than ${MIN_PAIRING_CODE_LENGTH} characters` };
  }
  const expiresAt = config.pairing?.expiresAt;
  if (expiresAt) {
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) return { usable: false, reason: 'pairing expiresAt is not a date' };
    if (now > deadline) return { usable: false, reason: 'pairing code expired' };
  }
  const maxAttempts = Number.isInteger(config.pairing?.maxAttempts) ? config.pairing.maxAttempts : 5;
  if (pairingAttempts >= maxAttempts) return { usable: false, reason: 'too many failed pairing attempts' };
  return { usable: true, code: code.trim() };
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

/** Constant-time equality, so a wrong guess leaks nothing through timing. */
function secretEquals(expected, actual) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(actual ?? ''), 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison of equal length to keep the work constant.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Single decision point for "should this inbound message reach C4?".
 *
 * Note that `allowed: false` with `boundOwner: true` is a real outcome, not a
 * contradiction: a correct pairing code binds the owner *and* withholds the
 * message, because that message body is the secret itself.
 *
 * @returns {{allowed: boolean, reason?: string, boundOwner?: boolean}}
 */
export function authorizeInbound(config, { spaceId, spaceType, senderId, senderName, text } = {}) {
  if (!spaceId) return { allowed: false, reason: 'missing space id' };

  if (spaceType === 'group') {
    if (!isGroupAllowed(config, spaceId)) return { allowed: false, reason: 'group not allowed' };
    if (!isGroupSenderAllowed(config, spaceId, senderId)) {
      return { allowed: false, reason: 'group sender not allowed' };
    }
    return { allowed: true };
  }

  // DM with no owner. Nothing is deliverable yet, and the sender does not get
  // to become the owner just by being first. The only thing this message can
  // do is present a pairing code that was shared out of band.
  if (!hasOwner(config)) {
    const pairing = pairingState(config);
    if (!pairing.usable) {
      return { allowed: false, reason: `owner not configured (${pairing.reason})` };
    }
    if (!senderId) {
      return { allowed: false, reason: 'owner not configured (sender has no id)' };
    }
    if (!secretEquals(pairing.code, String(text ?? '').trim())) {
      pairingAttempts += 1;
      return { allowed: false, reason: 'owner not configured (pairing code mismatch)' };
    }
    if (!bindOwner(config, senderId, senderName, { consumePairingCode: true })) {
      return { allowed: false, reason: 'owner binding failed' };
    }
    pairingAttempts = 0;
    return { allowed: false, boundOwner: true, reason: 'paired; code consumed, body withheld' };
  }

  if (!isDmAllowed(config, senderId)) return { allowed: false, reason: 'dm sender not allowed' };
  return { allowed: true };
}
