# Synapse (the org workspace's Matrix homeserver) for the Railway deploy
# (docs/deploy/railway.md, "Synapse and Postgres"). The config is not baked in:
# start.sh renders homeserver.yaml from env at every boot, so the secrets and
# the Postgres address stay in Railway variables. Pinned, not `latest` — the
# decision record (docs/deploy/hosted-workspace.md §11) wants >= v1.132.0.
FROM matrixdotorg/synapse:v1.161.0
COPY render_config.py ensure_db.py create_admin.py start.sh /
RUN chmod +x /start.sh
# The base image's entrypoint generates config from SYNAPSE_* env; ours renders
# a fixed, reviewed config instead.
ENTRYPOINT ["/start.sh"]
CMD []
