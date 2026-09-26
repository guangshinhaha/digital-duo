# Synapse (the org workspace's Matrix homeserver) for the Railway deploy
# (docs/deploy/railway.md, "Synapse and Postgres"). The config is not baked in:
# start.sh renders homeserver.yaml from env at every boot, so the secrets and
# the Postgres address stay in Railway variables. Pinned, not `latest` — the
# decision record (docs/deploy/hosted-workspace.md §11) wants >= v1.140.0.
FROM matrixdotorg/synapse:v1.161.0
COPY render_config.py ensure_db.py create_admin.py start.sh /
RUN chmod +x /start.sh
# The org wall (#235): a Synapse module Synapse imports by name from the
# `modules:` block render_config.py writes. On PYTHONPATH, not pip-installed:
# it is three small files, and the base image has no build step for it.
# Compiled here because Synapse runs as 991, which cannot write __pycache__.
# The tests are removed here as well as by .dockerignore (which depends on the uploader
# honouring it): faulty.py is a module that raises, and none of it belongs on PYTHONPATH.
# chmod after the compile, so 991 can read the sources and the .pyc whatever mode the build
# context had (a checkout made under umask 077 would otherwise stop Synapse starting).
COPY modules/ /modules/
RUN rm -rf /modules/duo_org_wall/tests \
 && python -m compileall -q /modules \
 && chmod -R a+rX /modules
ENV PYTHONPATH=/modules
# The base image's entrypoint (/start.py) generates config from SYNAPSE_* env
# and then drops to 991:991 with gosu; ours renders a fixed, reviewed config
# instead, so start.sh does the same drop itself (setup as root, Synapse as 991).
ENTRYPOINT ["/start.sh"]
CMD []
