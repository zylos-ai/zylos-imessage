# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- 103 tests (`node:test`), runnable without the SDK installed

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
