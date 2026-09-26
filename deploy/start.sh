#!/bin/sh
set -e
# The pre-hosted single-owner duo (served at the bare origin) — idempotent:
# creates its store under DUO_PASSPHRASE on first boot, leaves it alone after.
if [ -n "$DUO_PASSPHRASE" ]; then
  duo init
fi
# Railway's edge terminates TLS and is the only inbound path — hence the
# wildcard bind, which duo serve only accepts with --behind-proxy.
# --hosted: many duos, invite-only (docs/deploy/hosted-mode.md).
exec duo serve --hosted --host :: --port "${PORT:-7717}" --behind-proxy
