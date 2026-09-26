#!/bin/sh
set -eu
# Postgres first (Synapse refuses a database with the wrong collation), then
# the config, then Synapse itself.
python /ensure_db.py
python /render_config.py
exec python -m synapse.app.homeserver --config-path /etc/synapse/homeserver.yaml
