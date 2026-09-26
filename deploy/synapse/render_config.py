"""Render Synapse's homeserver.yaml and log config from env (run by start.sh).

The output is JSON, which is valid YAML, so values (passwords included) are
quoted correctly without a templating library. Secrets are read from env and
written only inside the container: the shared secret to a 0600 file that
homeserver.yaml points at, the database password into the 0600 config.
Nothing here logs a value.

Every setting below is deliberate — see docs/deploy/railway.md
("Synapse and Postgres") and docs/deploy/hosted-workspace.md §11.
"""
import json
import os
import sys

REQUIRED = [
    "SYNAPSE_PUBLIC_BASEURL",
    "SYNAPSE_DB_HOST",
    "SYNAPSE_DB_USER",
    "SYNAPSE_DB_PASSWORD",
]


def rate(per_second, burst):
    return {"per_second": per_second, "burst_count": burst}


def build_config(env, secret_path):
    missing = [name for name in REQUIRED if not env.get(name)]
    if missing:
        raise SystemExit("render_config: set " + ", ".join(missing))
    data_dir = env.get("SYNAPSE_DATA_DIR", "/data")
    # A provisioning burst (one admin account creating N people, N duos, their
    # rooms and joins) must not be throttled: the admin API's own joins skip
    # rate limits, but the accounts' first syncs, invites and messages do not.
    # Generous, not off. rc_login is left at Synapse's defaults on purpose:
    # the only password on this server is the service account's, and
    # failed-login throttling is what protects it (tokens are minted by the
    # admin API, which does not go through rc_login).
    generous = rate(1000, 10000)
    config = {
        "server_name": env.get("SYNAPSE_SERVER_NAME", "duo"),
        "public_baseurl": env["SYNAPSE_PUBLIC_BASEURL"],
        "pid_file": "/tmp/homeserver.pid",
        "report_stats": False,
        # One listener, client API only (which is where /_synapse/admin lives
        # too). No `federation` resource: the federation endpoints 404.
        "listeners": [
            {
                "port": int(env.get("PORT", "8008")),
                "bind_addresses": ["::"],  # Railway's private network is IPv6
                "type": "http",
                "x_forwarded": True,  # Railway's edge terminates TLS
                "resources": [{"names": ["client"], "compress": False}],
            }
        ],
        "database": {
            "name": "psycopg2",
            "args": {
                "user": env["SYNAPSE_DB_USER"],
                "password": env["SYNAPSE_DB_PASSWORD"],
                "database": env.get("SYNAPSE_DB_NAME", "synapse"),
                "host": env["SYNAPSE_DB_HOST"],
                "port": int(env.get("SYNAPSE_DB_PORT", "5432")),
                "sslmode": env.get("SYNAPSE_DB_SSLMODE", "prefer"),
                "cp_min": 5,
                "cp_max": 10,
            },
        },
        "log_config": "/etc/synapse/log.config",
        # Media and the signing key live on the Railway volume (/data).
        "media_store_path": data_dir + "/media_store",
        "signing_key_path": data_dir + "/signing.key",
        "max_upload_size": env.get("SYNAPSE_MAX_UPLOAD_SIZE", "50M"),
        "url_preview_enabled": False,
        # Closed system: nobody registers themselves.
        "enable_registration": False,
        # Federation off: empty whitelist blocks outbound, no federation
        # listener blocks inbound, no key servers to ask.
        "federation_domain_whitelist": [],
        "trusted_key_servers": [],
        "suppress_key_server_warning": True,
        "allow_public_rooms_over_federation": False,
        "allow_public_rooms_without_auth": False,
        # Org walls (hosted-workspace.md §6, §11): who can be found and what a
        # profile lookup or an invite reveals.
        "user_directory": {"enabled": True, "search_all_users": False},
        "require_auth_for_profile_requests": True,
        "limit_profile_requests_to_users_who_share_rooms": True,
        "include_profile_data_on_invite": False,
        "rc_message": generous,
        "rc_registration": generous,
        "rc_joins": {"local": generous, "remote": generous},
        "rc_joins_per_room": generous,
        "rc_invites": {"per_room": generous, "per_user": generous, "per_issuer": generous},
        "rc_third_party_invite": generous,
    }
    # The shared secret lets an operator create an admin even with
    # registration off (docs), so it is admin-equivalent. It is only wanted
    # for the one-time bootstrap of @workspace-admin (create_admin.py): with
    # the variable unset the shared-secret API is simply off — which
    # enable_registration: false alone does NOT achieve. Set, it goes into a
    # 0600 file, not into homeserver.yaml.
    if env.get("SYNAPSE_REGISTRATION_SHARED_SECRET"):
        config["registration_shared_secret_path"] = secret_path
    return config


def build_log_config():
    return {
        "version": 1,
        "formatters": {"precise": {"format": "%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s"}},
        "handlers": {
            "console": {"class": "logging.StreamHandler", "formatter": "precise", "filters": ["context"]}
        },
        "filters": {"context": {"()": "synapse.util.logcontext.LoggingContextFilter", "request": ""}},
        "loggers": {"synapse.storage.SQL": {"level": "INFO"}},
        "root": {"level": os.environ.get("SYNAPSE_LOG_LEVEL", "INFO"), "handlers": ["console"]},
        "disable_existing_loggers": False,
    }


def write_private(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(text)


def main(env=os.environ, out_dir="/etc/synapse", secret_path="/run/synapse-secrets/registration_shared_secret"):
    config = build_config(env, secret_path)
    if config.get("registration_shared_secret_path"):
        write_private(secret_path, env["SYNAPSE_REGISTRATION_SHARED_SECRET"])
    write_private(out_dir + "/homeserver.yaml", json.dumps(config, indent=2) + "\n")
    write_private(out_dir + "/log.config", json.dumps(build_log_config(), indent=2) + "\n")
    print("rendered homeserver.yaml for " + config["server_name"], flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 3:  # test hook: render_config.py <out_dir> <secret_path>
        main(out_dir=sys.argv[1], secret_path=sys.argv[2])
    else:
        main()
