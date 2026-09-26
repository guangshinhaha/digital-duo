# Synapse (the org workspace's Matrix homeserver) for the Railway deploy
# (docs/deploy/railway.md, "Synapse and Postgres"). The config is not baked in:
# start.sh renders homeserver.yaml from env at every boot, so the secrets and
# the Postgres address stay in Railway variables. Pinned, not `latest` — the
# decision record (docs/deploy/hosted-workspace.md §11) wants >= v1.140.0.
FROM matrixdotorg/synapse:v1.161.0
COPY render_config.py ensure_db.py create_admin.py start.sh /
RUN chmod +x /start.sh
# The base image's entrypoint (/start.py) generates config from SYNAPSE_* env
# and then drops to 991:991 with gosu; ours renders a fixed, reviewed config
# instead, so start.sh does the same drop itself (setup as root, Synapse as 991).
ENTRYPOINT ["/start.sh"]
CMD []
