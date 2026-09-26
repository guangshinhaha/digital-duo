#!/bin/sh
# `duo` inside the container: always run from the volume so relative store
# paths match the daemon's.
cd "${DUO_HOME:-/data}" && exec node /app/dist/cli.js "$@"
