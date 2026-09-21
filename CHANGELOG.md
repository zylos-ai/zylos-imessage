# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-21

Addresses the findings from two rounds of independent review of PR #1: five in
the first round, one more — a privacy blocker — in the second.

### Security
- **Breaking: the owner is no longer bound trust-on-first-use.** Previously the
  first inbound DM bound that sender as owner and was delivered, with an
  after-the-fact notice as the only safeguard — on a shared number that let a
  stranger take the owner slot. The owner must now be pre-configured
  (`owner.user_id`), or bound by presenting a `pairing.code` shared out of
  band (>= 8 chars, optional expiry, constant-time compare, attempt-capped,
  single-use, and never forwarded to C4). Until an owner exists, every DM is
  dropped; the daemon warns at startup so this is not mistaken for an outage.
- **Message bodies, contact names and full phone numbers are no longer
  logged.** Ids are masked to their last four characters via a new
  `src/lib/redact.js`. This also fixes a worse, previously unreported leak:
  `execFile`'s failure message embeds the full command line, whose last
  argument is `--content <entire body>`, so any C4 transport error wrote the
  complete message to `out.log`.
- **Delivery-failure logs no longer echo the command line at all.** The first
  fix above truncated it at `--content`, which still left
  `--endpoint <space id>` — and real Photon space ids embed the phone number —
  in both the first-failure and after-retry log lines. `describeExecFailure()`
  now reports only the error class, exit status and signal, with the
  destination logged separately and masked.
- `spaces.json` is now chmod'ed after write, not only on create.
- Test fixtures use documentation-range numbers (`+1555555xxxx`) only.

### Fixed
- Config hot reload survives atomic replacement. The watcher followed the
  config *file*, so the first rename-based save unlinked the watched inode and
  every later save fired nothing (measured: 1 event across 3 saves). It now
  watches the directory and filters by filename (3 of 3), and also picks up a
  config file created after startup.

### Added
- 9 integration tests that spawn the real `src/index.js` — previously nothing
  under `test/` loaded the entry point, so the inbound gate, self-send
  suppression, reconnect and shutdown paths were never executed by the suite.
  Covers stranger rejection, no-owner refusal, pairing, outbound-echo
  suppression, dropped-stream and failed-connect recovery, SIGTERM cleanup,
  and a no-PII-in-logs assertion. Verified to fail against the pre-fix commit.
- 3 tests covering the delivery-failure log paths. Two drive a real `execFile`
  failure — the real argv, against a stub child that exits 1 — and assert that
  neither the first-failure nor the after-retry line contains the number, the
  body, or the command line. Verified to fail against the pre-fix commit.
  Suite total: 124.

### Documentation
- Corrected the dependency assessment. 2.11.0 is **past** the fix line for
  GHSA-8988-4f7v-96qf (affects `@opentelemetry/core` < 2.8.0); the previous
  claim that no fix existed and an override was impossible was wrong. Residual
  exposure is six nested 2.7.1 copies behind the OTLP exporter chain. Measured
  with a loader hook: with `telemetry: false`, only the patched 2.11.0 copy is
  loaded and none of the 2.7.1 copies are. The limits of that measurement are
  now stated rather than generalized into an unqualified "not reachable".
- Removed the claim of end-to-end coverage the suite did not have, and
  reconciled the contradictory real-device / inbound-content statements.

### Upgrade Notes

```bash
zylos upgrade imessage
```

**Breaking — read before upgrading a running install.** The owner is no longer
bound by trust-on-first-use. After this upgrade a deployment with no
`owner.user_id` in `config.json` drops **every** inbound DM, silently from the
sender's point of view. Nothing in the message flow will tell you this is
happening; the daemon warns once at startup.

Set the owner before restarting:

```json
{ "owner": { "user_id": "+15555550100" } }
```

Or, to bind it interactively, add a pairing code and have the owner send
exactly that string as their first message:

```json
{ "pairing": { "code": "a-shared-secret-at-least-8-chars" } }
```

The code is single-use, attempt-capped, compared in constant time, optionally
expiring via `expiresAt`, and the message carrying it is consumed rather than
forwarded to C4.

Logs no longer contain message bodies, contact names, or full phone numbers, so
any log-scraping or alerting built against 0.2.0 output needs rechecking: ids
now appear masked (`***0100`) and delivery failures report only an error class
and exit status.

## [0.2.0] - 2026-09-21

First working implementation. The 0.1.0 scaffold did not move messages.

### Added
- iMessage transport over Photon (Spectrum SDK) — no Mac or Apple ID required
- Inbound pipeline: direction filter, replay dedupe, authorization, per-space
  rate limiting, content extraction, delivery to C4
- Outbound path: `scripts/send.js` → unix socket (0600) → daemon → Photon,
  with markdown stripping and chunking of long replies
- Access control: owner binding, `dmPolicy`, `groupPolicy` (disabled by default)
- Connection supervisor with exponential backoff reconnect
- Credential resolution from `config.json`, `process.env`, or `~/zylos/.env`,
  accepting Photon's own `SPECTRUM_*` names as a fallback
- 121 tests (`node:test`), runnable without the SDK installed

### Fixed
- **Endpoint encoding corrupted every real Photon space id, so no reply could
  ever be delivered.** `safeId()` replaced anything outside a narrow allowlist
  with `_`. Real space ids look like `any;-;+15555550100`, so the `;` were
  rewritten and the id no longer round-tripped — `space.get()` would not find
  the conversation and every outbound reply would fail. Encoding is now
  reversible: only `|` (field separator) and `%` (escape character) are
  escaped, and `parseEndpoint` decodes via a new `unsafeId()`. Found by the
  first live test against Photon; the stub used simple ids and could not
  surface it. The old test asserting the destructive behaviour was replaced,
  and three regression tests now pin real-world id shapes. Space ids never
  reach a shell (`c4.js` uses `execFile` with an argv array), so the
  character-stripping bought no injection safety.
- **Configure hook wrote keys the daemon could never read.** The hook derived
  config keys by stripping the `IMESSAGE_` prefix and lowercasing, producing
  `project_id`, while the loader reads `projectId`. Following the documented
  install flow left the component with no credentials and no error. Keys now go
  through an explicit allowlist, with a regression test.
- Configure hook now writes `config.json` at 0600 inside a 0700 directory, and
  tightens the directory even when it already exists (`mkdirSync`'s `mode` is
  ignored for an existing directory). The file can hold the project secret.
- Deduper evicted entries before inserting, letting the map exceed `maxEntries`
  by one.
- Regenerated `package-lock.json`, which was a copy-paste leftover from
  zylos-zalo (it declared `"name": "zylos-zalo"`).

### Security
- `config.json` permissions self-heal at startup if loosened
- Credentials sourced from the environment are never written back to disk
- `npm audit` reports 13 moderate advisories; all are one root cause
  (GHSA-8988-4f7v-96qf in `@opentelemetry/core`, via Photon's telemetry
  package). The vulnerable baggage-parsing path is not reachable from this
  component, and no fixed version exists upstream. See docs/DESIGN.md §5.3.

### Known limitations
- Inbound message *content* only reaches C4 once the component is installed as a
  channel. Run from a working copy, C4 rejects delivery with
  `invalid channel: directory not found (imessage)`.
- On the free tier the number is shared and cannot open a conversation — the
  human must send the first message.
- No attachment support; outbound `[MEDIA:*]` markers are rejected explicitly.

### Upgrade Notes

```bash
zylos upgrade imessage
```

New installs are prompted for `IMESSAGE_PROJECT_ID` and
`IMESSAGE_PROJECT_SECRET`. If you installed 0.1.0 and hand-edited
`config.json`, check that the credential keys are `projectId` / `projectSecret`
— a 0.1.0 install could have written `project_id` / `project_secret`, which the
daemon ignores.

## [0.1.0] - 2026-09-21

### Added
- Initial Zylos communication-component scaffold
- Lifecycle, configuration, and outbound-interface placeholders

The iMessage transport is not implemented in this version.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add imessage
```

No migration required.
