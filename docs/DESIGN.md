# zylos-imessage Design Document

**Version**: v1.0.0
**Date**: 2026-09-21
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-imessage
**Status**: Scaffold

---

## 1. Overview

This repository reserves the component identity and standard Zylos lifecycle
for a future iMessage communication channel. The transport and its platform
contract have not been selected or implemented.

## 2. Architecture

### 2.1 Component Structure

```
zylos-imessage/
  docs/
    DESIGN.md         — Architecture/design notes for maintainers and reviews
  src/
    index.js          — Entry point (start/stop lifecycle)
    lib/              — Core logic modules
  scripts/
    send.js           — Outbound message handler (communication components)
  hooks/
    UserPromptSubmit  — Claude Code hook for inbound messages (communication)
    post-install.js   — Post-install setup
    post-upgrade.js   — Post-upgrade config migration
  SKILL.md            — Component specification for the Zylos agent
  ecosystem.config.cjs — PM2 service configuration
```

### 2.2 Data Flow

No message data flows through the component yet. A future design must define
the Messages integration boundary, inbound delivery to C4, outbound addressing,
media behavior, retry semantics, and host-platform requirements before the
runtime stubs are replaced.

## 3. Configuration

### 3.1 Required Settings

No transport credentials or platform settings have been defined yet.

### 3.2 Config File

Located at `~/zylos/components/imessage/config.json`:

```json
{
  "enabled": true
}
```

## 4. Integration with Zylos

### 4.1 Lifecycle

- **Start**: Called by PM2 via `ecosystem.config.cjs`
- **Stop**: Graceful shutdown on SIGTERM

### 4.2 Message Flow

Not implemented. `scripts/send.js` deliberately returns an error until a real
transport contract exists.

## 5. Security

The implementation must define host access, conversation authorization, secret
storage, attachment handling, and retention before it can be enabled.

## 6. Error Handling

The scaffold fails outbound sends explicitly because no transport exists. The
future implementation must add bounded retries, sanitized errors, and graceful
shutdown of platform connections.

## 7. Future Improvements

- Select and document the supported iMessage integration mechanism
- Implement inbound C4 delivery and outbound replies
- Add tests for authorization, addressing, retries, media, and failure paths
