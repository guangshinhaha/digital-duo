# Embeddings-only Ollama for the Railway deploy (docs/deploy/railway.md).
# Completions go to OpenRouter; this serves nomic-embed-text on CPU, reachable
# only over Railway's private network.
FROM ollama/ollama:latest
# Railway private networking is IPv6 — listen on every interface of the
# container; the service gets no public domain.
ENV OLLAMA_HOST=[::]:11434
COPY start.sh /start.sh
RUN chmod +x /start.sh
ENTRYPOINT ["/start.sh"]
