# zylos-imessage Design Document

**Version**: 0.2.0
**Date**: 2026-09-21
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-imessage
**Status**: Implemented; real-device delivery verified 2026-09-21

---

## 1. Overview

An iMessage channel for Zylos agents. Apple-side integration is delegated to
[Photon](https://photon.ai) via its Spectrum SDK, so the component needs no Mac,
no Apple ID, and no local Messages database. The phone number belongs to Photon.

What this component owns: connection supervision, inbound authorization and
filtering, delivery into C4, and outbound replies.

### 1.1 Why Photon

The alternatives — driving Messages.app on a Mac, or reading `chat.db` — both
require a dedicated always-on Mac and break on macOS updates. Photon moves that
burden to a service. The cost is a third party in the message path, which is why
the access model below is conservative by default.

## 2. Architecture

### 2.1 Component structure

```
zylos-imessage/
  docs/DESIGN.md        — this document
  src/
    index.js            — daemon: connection supervisor + inbound pipeline + IPC
    lib/
      config.js         — config load/save, credential resolution, 0600 self-heal
      auth.js           — owner binding, DM policy, group policy
      c4.js             — inbound delivery to C4, bounded retry
      dedupe.js         — replay dedupe (TTL) + per-space rate limiting
      endpoint.js       — C4 endpoint id encode/decode
      format.js         — outbound text prep, markdown stripping, chunking
      ipc.js            — unix socket server/client, liveness probe
      spaces.js         — known-space registry
      spectrum.js       — lazy SDK loader + message shape adapters
  scripts/send.js       — C4 outbound entry point (IPC client)
  hooks/                — configure / post-install / pre-upgrade / post-upgrade
  test/                 — 103 tests (node:test)
  SKILL.md              — component spec for the Zylos agent
  ecosystem.config.cjs  — PM2 service definition
```

### 2.2 Data flow

```
inbound   iPhone -> Photon -> spectrum.messages -> handleInbound() -> c4-receive.js
outbound  C4 -> scripts/send.js -> unix socket -> daemon -> spectrum.send
```

### 2.3 Why outbound takes a socket detour

Photon sends only over the SDK's long-lived connection, which lives in the
daemon. `scripts/send.js` is a short-lived process invoked per reply, so it
cannot hold that connection. It therefore hands the message to the daemon over a
unix socket (0600) and reports the daemon's result.

If the daemon is down the send fails loudly. A silent drop would look to the
agent like a delivered reply.

### 2.4 Inbound filter chain

Order matters; each stage is cheap relative to the next.

1. **Direction** — `spectrum.messages` surfaces our own sends too; outbound is
   discarded first, otherwise the agent would read its own replies as input.
2. **Dedupe** — `spaceId:messageId` against a TTL map. Photon may replay after a
   reconnect; this is what makes reconnection safe.
3. **Authorization** — `authorizeInbound()` is the single decision point.
4. **Rate limit** — per space, with one warning per window.
5. **Content** — text extracted; non-text degraded to a placeholder. Messages
   with nothing renderable are dropped.

### 2.5 Connection supervision

The SDK's behaviour on a dropped stream has not been verified against the live
service, so the message iterator is wrapped in a supervisor with exponential
backoff (1s → 60s). If the SDK also retries internally this is redundant; if it
does not, it is the only thing keeping the channel online. Dedupe (2.4) makes
the redundant case harmless.

## 3. Configuration

### 3.1 Credential resolution

Order: `config.json` → `process.env` → `~/zylos/.env`. Both the component-scoped
`IMESSAGE_*` names and Photon's own `SPECTRUM_*` names are accepted, the former
winning, so a snippet copied from Photon's dashboard works unmodified.

`saveConfig()` deliberately does **not** write back a credential that came from
the environment. Persisting it would copy the secret into a second location for
no benefit.

### 3.2 Config file

`~/zylos/components/imessage/config.json`, 0600 inside a 0700 directory. The
file may hold the project secret, so permissions are enforced in two places: the
configure hook writes them, and the daemon re-tightens them at startup if they
have been loosened since.

Defaults and the full option table live in [SKILL.md](../SKILL.md).

## 4. Integration with Zylos

- **Start** — PM2, via `ecosystem.config.cjs`
- **Stop** — SIGTERM/SIGINT: stop config watcher, clear timers, close the socket
  (removing the file), stop the SDK client
- **Endpoint id** — `<spaceId>|type:<dm|group>|msg:<messageId>|req:<correlationId>`.
  Only `spaceId` is needed to reply; a Space object is not portable across
  processes, but its id is, so the daemon rebuilds it with `space.get(spaceId)`.
  The encoding must therefore be **reversible**: real space ids look like
  `any;-;+15555550100`, and an id that does not survive the round trip cannot
  be turned back into a Space, so every reply to that conversation fails. Only
  `|` (the field separator) and `%` (the escape character) are escaped; nothing
  is stripped. Space ids never reach a shell — `c4.js` uses `execFile` with an
  argv array — so character filtering would buy no injection safety anyway.

## 5. Security

### 5.1 Access model

- `dmPolicy`: `owner` (default) | `allowlist` | `open`
- `groupPolicy`: `disabled` (default) | `allowlist` | `open` — the free shared
  number has no group chat, so groups are off until there is a reason

**Owner binding is trust-on-first-use, not identity verification.** With no
owner configured, the first inbound DM binds that sender. Whoever messages the
number first becomes owner. This mirrors the zylos-zalo pattern, and carries the
same caveat, so the binding emits an out-of-band `admin|type:owner-binding` C4
notice demanding human confirmation. Setting `owner.user_id` before first start
avoids the race.

### 5.2 Secret handling

The project secret can appear in `config.json` (0600, self-healing) or the
environment. It is never logged, never echoed into C4, and never copied from env
to disk.

### 5.3 Dependency advisories

`npm audit` reports 13 moderate advisories. All 13 are the **same root cause**
fanned out transitively: GHSA-8988-4f7v-96qf, unbounded memory allocation in
`@opentelemetry/core`'s W3C Baggage propagation, reached via
`@spectrum-ts/* → @photon-ai/otel`.

Assessment (2026-09-21):

- **Not reachable from this component.** The vulnerable code is the baggage
  *extract/parse* path, which lives in `createIsolatedOtel()`. Nothing in
  `@spectrum-ts/*` calls it — its entire import surface from `@photon-ai/otel`
  is `createInstrumentedFetch`, `createLogger`, `setLogLevel`, `withSpan`, and
  the `sanitize*` helpers. This component never imports OpenTelemetry directly,
  and runs no HTTP server that would parse an attacker-supplied `baggage`
  header.
- **No fix exists upstream.** 2.11.0 is simultaneously the latest published
  `@opentelemetry/core` and a vulnerable one, so `npm audit fix` and a
  dependency override are both no-ops.
- **Impact class** is denial of service (unbounded allocation), not disclosure.

Action: accept and document; re-triage whenever the Photon SDK is upgraded.

## 6. Error handling

- One malformed message never tears down the stream; handler errors are caught
  per message.
- C4 delivery distinguishes an explicit `ok:false` policy rejection (do not
  retry — it will just be rejected again) from a transport failure (retry once,
  backed off). Retry timers are tracked so shutdown can clear them.
- Partial outbound chunking failures report which chunks were delivered. A
  partial send is not a no-op and must not be reported as one.
- `probeSocket()` distinguishes a live daemon from a stale socket left by a
  crash: stale sockets are reclaimed, a live one refuses takeover, preventing
  two daemons on one connection.

## 7. Testing

103 tests under `node:test`, no network required — the SDK is lazily imported
behind an `importModule` seam, so the suite runs without it installed. Time is
injectable in the deduper and rate limiter, so no test sleeps.

Covered end-to-end against a stubbed SDK: TOFU owner binding and its alert,
dedupe, self-send suppression, DM/group policy rejection, non-text degradation,
all four outbound paths (argv, stdin, chunking, unknown space), backoff
reconnect with replay suppression, and SIGTERM cleanup.

A bug was found this way and fixed: the deduper evicted *before* insert, letting
the map exceed `maxEntries` by one.

## 8. Known gaps / future work

- **Real-device delivery is unverified** — blocked on a Photon project that has
  completed the iMessage sync step (`imessageSynced: true`).
- No attachment support, inbound or outbound.
- Group chat untested; the free tier provides no way to exercise it.
- SDK reconnect semantics unconfirmed against the live service (see 2.5).
