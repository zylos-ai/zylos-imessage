---
name: imessage
version: 0.2.0
description: >
  iMessage communication channel for Zylos agents, delivered through the Photon
  (Spectrum) cloud service. Use when sending or receiving iMessages through
  Zylos, configuring the iMessage channel, or diagnosing its connection.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-imessage
    entry: src/index.js
  data_dir: ~/zylos/components/imessage
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-imessage
  branch: main

config:
  required:
    # Collected by zylos and piped to lifecycle.hooks.configure as stdin JSON.
    # Both may be left blank if they are already set in ~/zylos/.env — the
    # configure hook treats an empty value as "not supplied" and keeps any
    # existing setting.
    - name: IMESSAGE_PROJECT_ID
      description: "Photon project ID (Photon dashboard; its docs call this SPECTRUM_PROJECT_ID)"
      sensitive: false
    - name: IMESSAGE_PROJECT_SECRET
      description: "Photon project secret (Photon dashboard; its docs call this SPECTRUM_PROJECT_SECRET)"
      sensitive: true
  optional:
    - name: IMESSAGE_DM_POLICY
      description: "Who may DM the agent: owner | allowlist | open"
      default: "owner"
    - name: IMESSAGE_LOG_LEVEL
      description: "Log verbosity: debug | info | warn | error"
      default: "info"

dependencies: []
---

# iMessage

iMessage channel for Zylos, backed by [Photon](https://photon.ai) (the Spectrum
SDK). Photon owns the Apple-side integration; this component owns the Zylos
side: authorization, delivery into C4, and outbound replies.

No Mac and no Apple ID is required — the number belongs to Photon, not to you.

> [!IMPORTANT]
> **Verification status.** End-to-end send/receive against a real device is
> verified (2026-09-21), in both directions, against the live Photon service.
>
> One gap remains: inbound message *content* only reaches C4 once this component
> is installed as a channel. Run from a working copy, C4 rejects the delivery
> with `invalid channel: directory not found (imessage)` — the daemon sees the
> message, but nothing downstream does.

## How it works

```
inbound   iPhone -> Photon -> spectrum.messages -> filters -> c4-receive.js
outbound  C4 -> scripts/send.js -> unix socket -> daemon -> spectrum.send
```

Outbound goes through a socket rather than sending directly because Photon only
sends over the SDK's long-lived connection, which lives in the daemon process.

## Setup

1. Create a project at Photon and complete its **iMessage sync** step. Until
   that is done the service reports `imessageSynced: false` and no number is
   attached, so nothing can be sent or received.
2. Install and supply the credentials:

   ```bash
   zylos add imessage
   ```

3. Confirm the daemon is connected:

   ```bash
   pm2 logs zylos-imessage --lines 20
   ```

### On the free tier, the user must message first

The free tier uses a **shared** number, which cannot open a conversation. The
first message in any conversation has to come from the human, to the number
Photon assigned. After that, replies flow both ways normally.

## Configuration

Config lives in `~/zylos/components/imessage/config.json` (0600, inside a 0700
directory — it can hold the project secret).

Credentials may come from either `config.json` or the environment
(`IMESSAGE_PROJECT_ID` / `IMESSAGE_PROJECT_SECRET`, read from `process.env` or
`~/zylos/.env`; Photon's own `SPECTRUM_*` names are accepted as a fallback).
Environment-sourced credentials are deliberately **not** written back to
`config.json` — one secret in one place.

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Set false to stop the daemon at next start |
| `dmPolicy` | `owner` | `owner` \| `allowlist` \| `open` |
| `dmAllowFrom` | `[]` | Sender ids allowed when `dmPolicy: allowlist` |
| `groupPolicy` | `disabled` | `disabled` \| `allowlist` \| `open` |
| `message.maxLength` | `2000` | Longer replies are chunked |
| `dedupe.ttlMs` | `300000` | Replay window for repeated message ids |
| `rateLimit.max` | `60` | Inbound messages per space per window |

### Owner binding requires pre-configuration or a pairing code

The owner is never inferred from inbound traffic — the Photon number is
shared, so "messaged first" is not an identity claim. **Until an owner is
set, every DM is dropped** (the daemon warns about this at startup, so it is
not mistaken for an outage). Two ways to bind:

- Set `owner.user_id` in `config.json` before starting — the default.
- Set `pairing.code` to a secret shared out of band, then send exactly that
  text from the owner's device. The code must be >= 8 characters, supports an
  optional `pairing.expiresAt`, is capped at `pairing.maxAttempts` failures
  (default 5), and is consumed on first success so it cannot be replayed. The
  message carrying the code is never forwarded to C4.

Either way the binding raises an `admin|type:owner-binding` C4 notice.

## Sending

```bash
node scripts/send.js "<endpoint_id>" "message text"
echo "message text" | node scripts/send.js "<endpoint_id>"
```

Endpoint shape: `<spaceId>|type:<dm|group>|msg:<messageId>|req:<correlationId>`.
Only `spaceId` is required; the daemon rebuilds the Space from it.

Attachments are not supported — an outbound `[MEDIA:*]` marker is rejected with
an explicit error rather than sent as literal text.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `Photon credentials missing` | Neither `config.json` nor env has both values |
| Connected, but nothing arrives | Project has not completed iMessage sync, or the human has not messaged first |
| `not connected to Photon` on send | Daemon is up but its connection is down; it retries with backoff |
| Send fails, daemon is running | Stale socket — check `pm2 logs zylos-imessage` |

## Security notes

- `config.json` is forced to 0600 at startup and self-heals if loosened.
- Group chat is off by default; the free shared number has no group support.
- Inbound is filtered by direction, dedupe, authorization, rate limit, then
  content, before anything reaches C4.

## Design

Architecture notes: [docs/DESIGN.md](./docs/DESIGN.md).
