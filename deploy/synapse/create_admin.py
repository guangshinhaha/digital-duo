"""Create the service admin (@workspace-admin:<server_name>) and print an access token.

Run inside the synapse container (`railway ssh --service synapse -- python
/create_admin.py`); it talks to Synapse on localhost and reads its inputs from
the service's own variables. Idempotent: when the account exists it logs in
with SYNAPSE_ADMIN_PASSWORD instead, so it doubles as "mint a fresh token".

The token is the ONLY line on stdout; progress goes to stderr. Store it as
DUO_WORKSPACE_ADMIN_TOKEN on duo-daemon and nowhere else.

Uses the shared-secret registration API, which works while enable_registration
is false (docs/deploy/hosted-workspace.md §5) — the account is created admin.
That API is admin-equivalent, so once the account exists UNSET
SYNAPSE_REGISTRATION_SHARED_SECRET: without it the API is off, and this script
only logs in (it needs just SYNAPSE_ADMIN_PASSWORD). Set the secret again only
to create the account on a fresh server.

SYNAPSE_ADMIN_PASSWORD stays set for good (it is how a fresh token is minted),
and password login is on the public listener, so a short one is refused: use a
long random value (`openssl rand -hex 32`, 64 characters).
"""
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request

LOCALPART = "workspace-admin"
MIN_PASSWORD_LENGTH = 32


def call(base, method, path, body=None):
    request = urllib.request.Request(
        base + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def main(env=os.environ):
    secret = env.get("SYNAPSE_REGISTRATION_SHARED_SECRET")
    password = env.get("SYNAPSE_ADMIN_PASSWORD", "")
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit("create_admin: SYNAPSE_ADMIN_PASSWORD must be at least %d characters" % MIN_PASSWORD_LENGTH)
    base = "http://localhost:" + env.get("PORT", "8008")
    server_name = env.get("SYNAPSE_SERVER_NAME", "duo")

    if secret:
        status, nonce = call(base, "GET", "/_synapse/admin/v1/register")
        if status != 200 or "nonce" not in nonce:
            sys.exit(
                "create_admin: shared-secret registration is not enabled (nonce request: %s); "
                "set SYNAPSE_REGISTRATION_SHARED_SECRET, let the service restart, and run again" % status
            )
        # HMAC-SHA1 over nonce, user, password and the admin flag joined by NUL.
        mac = hmac.new(
            secret.encode(),
            b"\x00".join(p.encode() for p in (nonce["nonce"], LOCALPART, password, "admin")),
            hashlib.sha1,
        ).hexdigest()
        status, body = call(
            base,
            "POST",
            "/_synapse/admin/v1/register",
            {"nonce": nonce["nonce"], "username": LOCALPART, "password": password, "admin": True, "mac": mac},
        )
        if status == 200:
            print("created @%s:%s" % (LOCALPART, server_name), file=sys.stderr)
            print(body["access_token"])
            return
        if body.get("errcode") != "M_USER_IN_USE":
            sys.exit("register failed: %s %s" % (status, body.get("errcode")))
    status, body = call(
        base,
        "POST",
        "/_matrix/client/v3/login",
        {
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": LOCALPART},
            "password": password,
            "initial_device_display_name": "duo-daemon provisioning",
        },
    )
    if status != 200:
        hint = "" if secret else " (if the account does not exist yet, set SYNAPSE_REGISTRATION_SHARED_SECRET and run again)"
        sys.exit("login failed: %s %s%s" % (status, body.get("errcode"), hint))
    print("account existed; minted a new token", file=sys.stderr)
    print(body["access_token"])


if __name__ == "__main__":
    main()
