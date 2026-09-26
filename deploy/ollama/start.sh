#!/bin/sh
set -e
ollama serve &
pid=$!
# Wait for the server, then make sure the embedding model is present (a
# no-op once it's on the volume at /root/.ollama).
until ollama list >/dev/null 2>&1; do sleep 1; done
ollama pull "${EMBEDDING_MODEL:-nomic-embed-text}"
wait $pid
