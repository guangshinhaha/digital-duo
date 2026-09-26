#!/bin/sh
set -eu
# Postgres first (Synapse refuses a database with the wrong collation), then
# the config, then Synapse itself.
python /ensure_db.py
python /render_config.py
# Setup ran as root (it writes /etc/synapse and /run). Synapse does not: like
# the base image's /start.py, hand over what it reads and writes (the volume,
# the rendered config, the 0600 secret file) and drop to 991:991 with gosu.
chown -R 991:991 /data /etc/synapse
[ ! -d /run/synapse-secrets ] || chown -R 991:991 /run/synapse-secrets
exec gosu 991:991 python -m synapse.app.homeserver --config-path /etc/synapse/homeserver.yaml
