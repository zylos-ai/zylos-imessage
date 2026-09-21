---
name: imessage
version: 0.1.0
description: >
  Scaffold for an iMessage communication channel for Zylos agents. Use when
  developing or reviewing the future iMessage integration; message transport is
  not implemented yet.
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

# For HTTP services exposed through Zylos Caddy, prefer a root-internal app:
# - The component listens on localhost and serves internal routes at /.
# - Caddy exposes it at /imessage/*, strips that prefix, and forwards
#   X-Forwarded-Prefix. Browser URLs should be relative by default and should
#   use X-Forwarded-Prefix when present.
# http_routes:
#   - path: /imessage/*
#     type: reverse_proxy
#     target: localhost:3000
#     strip_prefix: /imessage

upgrade:
  repo: zylos-ai/zylos-imessage
  branch: main

config:
  required:
    # Values are collected by zylos and passed to lifecycle.hooks.configure as stdin JSON.
    # The configure hook decides how to store them in config.json.
    # - name: IMESSAGE_API_KEY
    #   description: API key for imessage
    #   sensitive: true
  optional:
    # - name: IMESSAGE_DEBUG
    #   description: Enable debug mode
    #   default: "false"

dependencies: []
---

# Imessage

This repository currently contains the standard Zylos communication-component
scaffold. It does not yet connect to Messages or send and receive iMessages.

Do not install it as an operational channel until the transport, access model,
and platform requirements have been designed and implemented.
