# zylos-imessage Design Document

**Version**: 0.3.0
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
  test/                 — 121 tests (node:test), incl. integration.test.js
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

**The owner is never inferred from traffic.** Photon's iMessage number is
shared, so "whoever messaged first" is not an identity claim — it is whoever
happened to message first, including a stranger or a wrong number.

Earlier versions bound the first inbound DM as owner (trust-on-first-use,
mirroring zylos-zalo) and relied on an after-the-fact C4 notice as the
safeguard. That was wrong in two ways: the notice fires *after* the stranger's
message has already been delivered, and a notice is not an access control. It
has been removed. There are now exactly two ways to become owner:

1. **Pre-binding (default).** Set `owner.user_id` in `config.json`. Until it is
   set, every DM is dropped and nothing is forwarded. The daemon warns loudly
   at startup so this does not look like a silent outage.
2. **Pairing code.** Set `pairing.code` to a secret shared out of band. A DM
   whose text matches it binds that sender. The code must be at least 8
   characters, may carry an `expiresAt`, is compared in constant time, is
   limited to `pairing.maxAttempts` (default 5) failures per process, and is
   consumed in the same atomic write that records the owner — so it cannot be
   replayed to rebind someone else. The message carrying the code is **not**
   forwarded to C4: that body is the secret. An `admin|type:owner-binding`
   notice announces the binding instead.

The notice is still emitted, but as a report of an authorized event, not as
the thing standing between a stranger and the agent.

### 5.2 Secret handling

The project secret can appear in `config.json` (0600, self-healing) or the
environment. It is never logged, never echoed into C4, and never copied from env
to disk.

### 5.3 Dependency advisories

`npm audit` reports 13 moderate advisories. All 13 are the **same root cause**
fanned out transitively: GHSA-8988-4f7v-96qf, unbounded memory allocation in
`@opentelemetry/core`'s W3C Baggage propagation, reached via
`@spectrum-ts/* → @photon-ai/otel`.

Assessment (revised 2026-09-21 after review; the previous version of this
section was wrong on the central fact and is corrected below).

**What the advisory actually covers.** GHSA-8988-4f7v-96qf affects
`@opentelemetry/core` **< 2.8.0**. It is fixed in 2.8.0 and later.

**What is in our tree.** `npm audit` reports **13 moderate, 0 high, 0
critical**. The lockfile contains seven copies of `@opentelemetry/core`:

| Copy | Version | Affected |
|---|---|---|
| `@opentelemetry/core` (top level) | 2.11.0 | no — patched |
| 6 nested copies under `exporter-*-otlp-http`, `otlp-exporter-base`, `otlp-transformer`, `sdk-logs` | 2.7.1 | yes |

**Correction.** The earlier claim that "2.11.0 is simultaneously the latest and
a vulnerable one, so `npm audit fix` and an override are both no-ops" was
false: 2.11.0 is past the fix line. The residual exposure is the six **nested
2.7.1** copies, pinned by the OTLP exporter packages — not the top-level one.

**Reachability, measured rather than asserted.** With an ESM loader hook
recording every module load, importing `@spectrum-ts/core` +
`@spectrum-ts/imessage` and calling `Spectrum({ telemetry: false })`:

- exactly **one** `@opentelemetry/core` copy is loaded: the top-level
  **2.11.0**, i.e. patched code;
- **zero** of the six vulnerable 2.7.1 copies are loaded — they sit behind the
  OTLP exporter chain, which this configuration never pulls in;
- `W3CBaggagePropagator` *is* loaded (the earlier "nothing calls it" wording
  was too strong), but from the 2.11.0 package.

Independently, `@spectrum-ts/*` imports only `createInstrumentedFetch`,
`createLogger`, `setLogLevel`, `withSpan`, `LogLevel` and the `sanitize*`
helpers from `@photon-ai/otel`; `createIsolatedOtel` — where the baggage
extract path lives — has no call site anywhere in `@spectrum-ts`. This
component never imports OpenTelemetry directly and runs no HTTP server, so
there is no inbound `baggage` header from an untrusted peer to parse.

**Impact class** is denial of service (unbounded allocation), not disclosure.

**Scope of this verification / what is NOT established.** The measurement
above covers module load during import and one `Spectrum()` call that failed
credential validation. It does **not** prove that no code path in a long-lived
authenticated session ever loads the exporter chain, and it does not cover a
build that enables telemetry — with `telemetry: true` the OTLP exporters, and
with them the 2.7.1 copies, would be expected to load.

Action: accept for the default `telemetry: false` configuration and document;
re-triage whenever the Photon SDK is upgraded or telemetry is switched on. If
the nested copies need to be eliminated, an `overrides` entry pinning
`@opentelemetry/core` to >= 2.8.0 is the lever — contrary to what this section
previously claimed, that is available.

### 5.4 Logging and personal data

Everything this component handles is personal data: the sender id is a phone
number, the display name is a real name, and the body is private
correspondence. The daemon's stdout is captured by PM2 into `out.log`, which
has **no retention policy** and lives beside the data dir.

The rule is therefore that **message bodies and contact names never reach a
log line at all**, and ids are reduced to the minimum needed to correlate two
lines about the same conversation. `src/lib/redact.js` is the single place
that decides this: ids are masked to their last four characters
(`+15555550100` → `***0100`), names are dropped, and endpoint ids are masked
component-wise because real space ids embed the number (`any;-;+1555...`).

Three leaks were fixed here:

- `c4.js` logged the first 60 characters of every delivered body.
- More seriously, the same file logged `error.message` on a delivery failure.
  `execFile` formats that as `Command failed: <file> <args...>`, and our argv
  ends with `--content <the entire message body>` — so any C4 transport error
  wrote the **whole** message to disk.
- The first fix for that truncated the command line at `--content`, which
  dropped the body but kept the head — and the head still carried
  `--endpoint <space id>`, i.e. the full phone number, on both the first-failure
  and the after-retry path. Trimming a command line is the wrong shape: every
  new flag is another way to leak. `describeExecFailure()` therefore derives
  nothing from the command line, stdout or stderr. It reports only the error
  class, exit status and signal; the destination is logged separately through
  `redactEndpoint()`.

An integration test asserts that no body, contact name or full number appears
in the daemon's output across the delivery, duplicate and rejection paths, and
unit tests drive a real `execFile` failure — with the real argv, via a stub
child that exits 1 — to assert the same of both failure paths.

`spaces.json` (0600) does retain contact ids and names. That is a functional
registry rather than a log — the daemon needs it to describe known
conversations — but it is the one place at rest where those values persist.

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

121 tests under `node:test`, no network required. Time is injectable in the
deduper and rate limiter, so the unit tests do not sleep.

**Module tests (112).** Each module in isolation: config loading/merging/
permissions and hot reload, authorization policy, pairing, dedupe and rate
limiting, endpoint encoding round-trips, outbound formatting and chunking, the
IPC server, the send script, the configure hook, and the SDK wrapper (behind
an `importModule` seam, so the suite runs without the SDK installed).

**Integration tests (9, `test/integration.test.js`).** These spawn the real
`src/index.js` as a child process — an earlier version of this document
claimed end-to-end coverage that the suite did not actually have, because
nothing under `test/` loaded the entry point at all. They use an isolated
`HOME`, resolve `@spectrum-ts/*` to local stubs via a Node loader hook, and
substitute a recording `c4-receive.js`. The daemon itself is unmodified.

Covered: owner delivery; stranger rejection; no-owner/no-pairing-code refusal
including "the stranger was not persisted as owner"; pairing-code binding with
the code withheld from C4; self-send (outbound echo) suppression; recovery
from a dropped stream; recovery from a failed connect; SIGTERM clean exit with
socket removal; and a privacy assertion that no message body, contact name or
full phone number ever reaches the daemon's log.

The integration tests were also run against the pre-fix commit to confirm they
fail there — three do — so they are regression tests rather than restatements
of current behaviour.

Two bugs were found this way and fixed: the deduper evicted *before* insert,
letting the map exceed `maxEntries` by one; and `execFile`'s failure message
embeds the whole command line, which put the entire message body into the log
on any C4 transport error (see 5.4).

## 8. Known gaps / future work

- **Inbound content does not reach C4 until the component is installed as a
  channel.** Run from a working copy, C4 refuses the delivery with
  `invalid channel (imessage)`: the daemon receives and authorizes the
  message, but nothing downstream accepts it. This is the one real gap in the
  otherwise-verified round trip, and it is why §1 says "delivery verified" and
  this section still lists a gap — they are about different hops.
- No attachment support, inbound or outbound.
- Group chat untested; the free tier provides no way to exercise it.
- SDK reconnect semantics unconfirmed against the live service (see 2.5).
