#!/bin/sh
set -e
# Idempotent: creates the encrypted store under DUO_PASSPHRASE on first boot,
# leaves an existing one untouched.
duo init
# Railway's edge terminates TLS and is the only inbound path — hence the
# wildcard bind, which duo serve only accepts with --behind-proxy.
exec duo serve --host :: --port "${PORT:-7717}" --behind-proxy
