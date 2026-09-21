<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-imessage</h1>

<p align="center">
  iMessage communication channel for Zylos agents
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://openmax.com"><img src="https://img.shields.io/badge/Built%20by-OpenMax-orange" alt="Built by OpenMax"></a>
</p>

---

Send and receive iMessages from a Zylos agent, through the
[Photon](https://photon.ai) cloud service (Spectrum SDK). Photon owns the
Apple-side integration, so **no Mac and no Apple ID are required** — the phone
number belongs to Photon.

> [!IMPORTANT]
> **Verification status.** Delivery to and from a **real device** is verified
> (2026-09-21): an iMessage sent from an iPhone reached the daemon and bound the
> owner, and a reply sent with `scripts/send.js` was accepted by Photon and
> arrived on the device. The pipeline is additionally covered by 112 module
> tests and 9 integration tests that spawn the real daemon against a stubbed
> SDK.
>
> One gap remains: inbound message *content* only reaches C4 once the component
> is installed as a channel. Run from a working copy, C4 rejects the delivery
> with `invalid channel: directory not found (imessage)` — the daemon sees the
> message, but nothing downstream does.

- **Inbound** — Photon → filters (direction, dedupe, authorization, rate limit,
  content) → C4
- **Outbound** — C4 → `scripts/send.js` → unix socket → daemon → Photon
- **Access control** — owner binding, DM policy, group policy (off by default)
- **Secret handling** — config forced to 0600; env-sourced credentials are never
  copied to disk

## Install

```bash
zylos add imessage
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zylos-ai/zylos-imessage.git imessage
cd imessage && npm install
```

You will need a Photon project that has completed its **iMessage sync** step.
Until it has, the service reports `imessageSynced: false`, no number is
attached, and nothing can be sent or received.

## Configuration

Credentials can live in the environment (preferred — one secret in one place):

```bash
# ~/zylos/.env
IMESSAGE_PROJECT_ID=...
IMESSAGE_PROJECT_SECRET=...
```

Photon's own docs call these `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET`;
those names are accepted as a fallback so a copy-pasted snippet works.

Or in `~/zylos/components/imessage/config.json` (kept at 0600 — it can hold the
project secret):

```json
{
  "enabled": true,
  "dmPolicy": "owner",
  "groupPolicy": "disabled",
  "message": { "maxLength": 2000 },
  "rateLimit": { "windowMs": 60000, "max": 60 }
}
```

See [SKILL.md](./SKILL.md) for the full option table.

## Usage

On the free tier the number is **shared**, and a shared number cannot open a
conversation. The human sends the first message to the Photon-assigned number;
after that, replies flow both ways.

Outbound:

```bash
node scripts/send.js "<endpoint_id>" "message text"
echo "message text" | node scripts/send.js "<endpoint_id>"
```

Attachments are not supported; an outbound `[MEDIA:*]` marker is rejected with
an explicit error rather than delivered as literal text.

## Security

- **The owner is never inferred from inbound traffic.** The number is shared,
  so "messaged first" proves nothing. Set `owner.user_id` in `config.json`
  before first start — until it is set, every DM is dropped. Alternatively set
  `pairing.code` (>= 8 chars, optional `expiresAt`, attempt-capped, single-use)
  and bind by sending that code from the owner's device; the code itself is
  never forwarded to C4.
- **Message bodies, contact names and full phone numbers are never written to
  the log.** Sender ids are masked to their last four characters. The daemon's
  stdout goes to pm2's `out.log`, which has no retention policy.
- Group chat is disabled by default; the free shared number has no group
  support.
- `config.json` is tightened to 0600 at startup if it has been loosened.

## Development

```bash
npm test     # 121 tests, node:test, no network required
             # 112 module tests + 9 integration tests that spawn src/index.js
```

The Photon SDK is lazily imported behind a test seam, so the full suite runs
without the SDK installed.

## Design Notes

Architecture notes live in [docs/DESIGN.md](./docs/DESIGN.md).

## Built by OpenMax

Zylos is the open-source core of [OpenMax](https://openmax.com/) — the Human × Agent Collaboration Platform.

## License

[MIT](./LICENSE)
