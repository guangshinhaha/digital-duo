"""Drive a REAL Synapse with the org wall loaded, over HTTP (opt-in; see docs/deploy/railway.md).

Run it with a Python that has matrix-synapse installed (the version the image
pins, deploy/synapse/Dockerfile):

    python -m venv venv && venv/bin/pip install matrix-synapse==1.161.0
    venv/bin/python deploy/synapse/modules/duo_org_wall/tests/real_synapse.py

It renders the homeserver config with deploy/synapse/render_config.py (so the
`modules:` block under test is the one the image ships), swaps only what a laptop
needs (SQLite, a loopback port, a temp dir), starts Synapse as a subprocess, bootstraps
the service account with deploy/synapse/create_admin.py, creates two orgs' people
through the admin API and checks the wall with ordinary client requests. Each phase
restarts Synapse on the same database. Nothing is sent anywhere but 127.0.0.1.

`--serve` starts just the shipped configuration, bootstraps the service account and waits
(test/synapse-org-wall.test.ts drives the daemon's own TypeScript provisioning against it).
It prints `READY <file>`; the file (mode 0600, in a temp dir) holds the base URL and the
service account's token, which is never printed. SIGTERM stops Synapse.

Exit status 0 only if every check passed. Nothing secret is printed.
"""
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SYNAPSE_DIR = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MODULES_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, SYNAPSE_DIR)
import render_config  # noqa: E402

SERVER = "duo"
ORG_A, ORG_B = "orga1111", "orgb2222"
ALICE, ALICE_DUO, BOB = "@%s.alice:%s" % (ORG_A, SERVER), "@duo-%s.alice:%s" % (ORG_A, SERVER), "@%s.bob:%s" % (ORG_A, SERVER)
CAROL, CAROL_DUO = "@%s.carol:%s" % (ORG_B, SERVER), "@duo-%s.carol:%s" % (ORG_B, SERVER)
ADMIN = "@workspace-admin:" + SERVER
MALLORY = "@mallory:" + SERVER  # no org marker
TWO_DOTS = "@%s.dot.dot:%s" % (ORG_A, SERVER)  # malformed: two dots
NAMES = {ALICE: "Wall Alice", ALICE_DUO: "Wall Alice Duo", BOB: "Wall Bob", CAROL: "Wall Carol", CAROL_DUO: "Wall Carol Duo", MALLORY: "Wall Mallory", TWO_DOTS: "Wall Dots"}

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  <- " + str(detail)), flush=True)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Server:
    def __init__(self, workdir, port):
        self.workdir, self.port, self.proc, self.log_path = workdir, port, None, None
        self.base = "http://127.0.0.1:%d" % port
        self.secret = secrets.token_hex(16)
        self.admin_password = secrets.token_hex(32)

    def write_config(self, module=None, search_all_users=False):
        env = {
            "SYNAPSE_PUBLIC_BASEURL": self.base,
            "SYNAPSE_DB_HOST": "unused", "SYNAPSE_DB_USER": "unused", "SYNAPSE_DB_PASSWORD": "unused",
            "SYNAPSE_SERVER_NAME": SERVER,
            "SYNAPSE_REGISTRATION_SHARED_SECRET": self.secret,
        }
        config = render_config.build_config(env, os.path.join(self.workdir, "shared_secret"))
        with open(os.path.join(self.workdir, "shared_secret"), "w") as handle:
            handle.write(self.secret)
        config["listeners"] = [{"port": self.port, "bind_addresses": ["127.0.0.1"], "type": "http", "resources": [{"names": ["client"], "compress": False}]}]
        config["database"] = {"name": "sqlite3", "args": {"database": os.path.join(self.workdir, "homeserver.db")}}
        config["pid_file"] = os.path.join(self.workdir, "homeserver.pid")
        config["media_store_path"] = os.path.join(self.workdir, "media")
        config["signing_key_path"] = os.path.join(self.workdir, "signing.key")
        config["user_directory"]["search_all_users"] = search_all_users
        config["rc_room_creation"] = render_config.rate(1000, 10000)  # the test makes many rooms as one person
        if module is None:
            del config["modules"]
        elif module != "shipped":
            config["modules"] = [{"module": module, "config": config["modules"][0]["config"]}]
        log_config = render_config.build_log_config()
        log_config["handlers"]["console"] = {"class": "logging.FileHandler", "formatter": "precise", "filename": self.log_path, "filters": ["context"]}
        with open(os.path.join(self.workdir, "log.config"), "w") as handle:
            json.dump(log_config, handle)
        config["log_config"] = os.path.join(self.workdir, "log.config")
        with open(os.path.join(self.workdir, "homeserver.yaml"), "w") as handle:
            json.dump(config, handle)  # JSON is YAML
        return config

    def start(self, label, module="shipped", search_all_users=False):
        self.log_path = os.path.join(self.workdir, "synapse-%s.log" % label)
        self.write_config(module, search_all_users)
        env = {**os.environ, "PYTHONPATH": os.pathsep.join([MODULES_DIR, HERE]), "PYTHONUNBUFFERED": "1"}
        cmd = [sys.executable, "-m", "synapse.app.homeserver", "--config-path", os.path.join(self.workdir, "homeserver.yaml")]
        if not os.path.exists(os.path.join(self.workdir, "signing.key")):
            subprocess.run(cmd + ["--generate-keys"], check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.proc = subprocess.Popen(cmd, env=env, cwd=self.workdir, stdout=subprocess.DEVNULL, stderr=open(os.path.join(self.workdir, "stderr-%s.txt" % label), "w"))
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise SystemExit("synapse exited early (%s); see %s and the stderr file beside it" % (self.proc.returncode, self.log_path))
            try:
                with urllib.request.urlopen(self.base + "/health", timeout=2):
                    return
            except Exception:
                time.sleep(0.5)
        raise SystemExit("synapse did not come up")

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def log(self):
        with open(self.log_path) as handle:
            return handle.read()


def call(server, method, path, token=None, body=None):
    request = urllib.request.Request(
        server.base + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"content-type": "application/json", **({"authorization": "Bearer " + token} if token else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw or b"{}")
        except ValueError:
            return error.code, {"raw": raw[:200].decode(errors="replace")}


def q(value):
    return urllib.parse.quote(value, safe="")


class Actors:
    def __init__(self, server):
        self.server, self.tokens = server, {}

    def create(self, user_id, admin_token):
        status, _ = call(self.server, "PUT", "/_synapse/admin/v2/users/" + q(user_id), admin_token, {"displayname": NAMES[user_id], "admin": False})
        assert status in (200, 201), (user_id, status)
        status, body = call(self.server, "POST", "/_synapse/admin/v1/users/%s/login" % q(user_id), admin_token, {})
        assert status == 200, (user_id, status)
        self.tokens[user_id] = body["access_token"]


def refused(result, sentence=None):
    status, body = result
    ok = status == 403 and body.get("errcode") == "M_FORBIDDEN"
    return ok and (sentence is None or sentence in body.get("error", ""))


def search(server, token, term="Wall"):
    status, body = call(server, "POST", "/_matrix/client/v3/user_directory/search", token, {"search_term": term, "limit": 50})
    assert status == 200, status
    return {row["user_id"] for row in body["results"]}


def wait_search(server, token, expect_present, term="Wall"):
    for _ in range(60):
        found = search(server, token, term)
        if expect_present <= found:
            return found
        time.sleep(0.5)
    return search(server, token, term)


def phase_main(server, admin, actors, ctx):
    A = lambda user_id: actors.tokens[user_id]  # noqa: E731
    A_TOKENS = actors.tokens
    print("\nPhase 1: module loaded, search_all_users false (the shipped config)")
    check("the module loaded (log says so)", "duo_org_wall loaded" in server.log())

    # The org rooms exactly as src/hosted/synapse-admin.ts createPrivateRoom builds them.
    def org_room(name, space):
        body = {"name": name, "visibility": "private", "preset": "private_chat", "power_level_content_override": {"invite": 100, **({"events_default": 100} if space else {})}}
        if space:
            body["creation_content"] = {"type": "m.space"}
        status, out = call(server, "POST", "/_matrix/client/v3/createRoom", admin, body)
        assert status == 200, status
        return out["room_id"]

    space_a, general_a, space_b, general_b = org_room("Org A", True), org_room("Org A general", False), org_room("Org B", True), org_room("Org B general", False)
    ctx.update(space_a=space_a, general_a=general_a, space_b=space_b, general_b=general_b)
    check("service account creates private org Space and #general (admin skips user_may_create_room)", True)

    def admin_join(room, user_id):
        return call(server, "POST", "/_synapse/admin/v1/join/" + q(room), admin, {"user_id": user_id})

    for user in (ALICE, ALICE_DUO, BOB):
        ok = all(admin_join(room, user)[0] == 200 for room in (space_a, general_a))
        check("admin-API join of same-org %s into the org's private Space and #general works (module sees is_invited=True)" % user.split(":")[0], ok)
    for user in (CAROL, CAROL_DUO):
        ok = all(admin_join(room, user)[0] == 200 for room in (space_b, general_b))
        check("admin-API join of %s into org B's rooms works" % user.split(":")[0], ok)

    result = admin_join(general_a, CAROL)
    check("admin-API join of an org B user into org A's #general is refused with a clear error", refused(result, "another organisation"), result)
    result = admin_join(space_b, ALICE_DUO)
    check("admin-API join of an org A duo into org B's Space is refused", refused(result), result)
    result = call(server, "POST", "/_matrix/client/v3/join/" + q(general_a), A_TOKENS[CAROL], {})
    check("carol cannot accept the invite the refused admin join left behind (her own join is refused too)", refused(result, "another organisation"), result)
    status, sync = call(server, "GET", "/_matrix/client/v3/sync?timeout=0", A_TOKENS[CAROL])
    invited = sync.get("rooms", {}).get("invite", {}).get(general_a)
    kinds = sorted({event["type"] for event in (invited or {}).get("invite_state", {}).get("events", [])})
    check("OBSERVED: the refused admin-API join leaves the admin's invite pending on carol (the invite goes out before the join is judged); invite_state carries %s" % kinds, invited is not None, sync.get("rooms"))
    ctx["invite_state_types"] = kinds
    result = admin_join(general_a, MALLORY)
    check("admin-API join of an account with no org marker into an org room is refused (fails closed)", refused(result), result)
    result = admin_join(general_a, TWO_DOTS)
    check("admin-API join of a malformed id (two dots) into an org room is refused", refused(result), result)

    # Invites, in rooms the person created (power level 100 there, so only the module can say no).
    def make_room(user_id, extra=None):
        return call(server, "POST", "/_matrix/client/v3/createRoom", A(user_id), {"preset": "private_chat", "name": "t", **(extra or {})})

    status, room = make_room(ALICE)
    check("alice creates a private room", status == 200, room)
    room_id = room.get("room_id")
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room_id), A(ALICE), {"user_id": BOB})
    check("same-org invite (alice -> bob) works", result[0] == 200, result)
    result = call(server, "POST", "/_matrix/client/v3/join/" + q(room_id), A(BOB), {})
    check("bob joins the room he was invited to", result[0] == 200, result)
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room_id), A(ALICE), {"user_id": ALICE_DUO})
    check("same-org invite of her own duo works", result[0] == 200, result)
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room_id), A(ALICE), {"user_id": CAROL})
    check("cross-org invite (alice -> carol) is refused, with a clear error", refused(result, "across organisations"), result)
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room_id), A(ALICE), {"user_id": MALLORY})
    check("invite of an account with no org is refused", refused(result), result)
    result = make_room(MALLORY)
    check("an account with no org cannot create a room", refused(result, "does not belong"), result)

    result = make_room(ALICE, {"is_direct": True, "invite": [BOB]})
    check("a DM to a same-org user works", result[0] == 200, result)
    result = make_room(ALICE, {"is_direct": True, "invite": [CAROL]})
    check("a DM to another org is refused", refused(result, "across organisations"), result)
    result = make_room(ALICE, {"invite": [BOB, CAROL]})
    check("a room created with one cross-org id in `invite` is refused", refused(result), result)
    result = make_room(ALICE, {"invite_3pid": [{"id_server": "id.example", "id_access_token": "x", "medium": "email", "address": "x@example.com"}]})
    check("a room created with a 3pid invite is refused", refused(result, "email or phone"), result)
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room_id), A(ALICE), {"id_server": "id.example", "id_access_token": "x", "medium": "email", "address": "x@example.com"})
    check("a 3pid invite to an existing room is refused by user_may_send_3pid_invite", refused(result, "email or phone") and "user_may_send_3pid_invite refused" in server.log(), result)

    # Public rooms, every way in.
    result = make_room(ALICE, {"visibility": "public"})
    check("visibility: public is refused", refused(result, "Public rooms"), result)
    result = make_room(ALICE, {"preset": "public_chat"})
    check("preset: public_chat is refused", refused(result, "Public rooms"), result)
    result = call(server, "POST", "/_matrix/client/v3/createRoom", A(ALICE), {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "public"}}]})
    check("initial_state join_rules public, with no visibility and no preset, is refused (the path check_event_for_spam never sees)", refused(result, "Public rooms"), result)
    result = make_room(ALICE, {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "knock"}}]})
    check("initial_state join_rules knock is refused", refused(result), result)
    result = make_room(ALICE, {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}}]})
    check("initial_state join_rules invite is allowed", result[0] == 200, result)
    restricted = lambda room: [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": room}]}}]  # noqa: E731
    result = make_room(ALICE, {"initial_state": restricted(space_a)})
    check("restricted to alice's own org Space (which holds only her org) is allowed", result[0] == 200, result)
    result = make_room(ALICE, {"initial_state": restricted(space_b)})
    check("restricted to another org's Space is refused", refused(result), result)
    result = make_room(ALICE, {"initial_state": restricted("!nosuchroom:" + SERVER)})
    check("restricted to a room that does not exist is refused (fails closed)", refused(result), result)
    result = make_room(ALICE, {"initial_state": ["not-an-object"]})
    check("a malformed initial_state entry does not create a room (Synapse's own validation 500s before the module is asked; rules.py is unit-tested on it)", result[0] >= 400, result)

    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.join_rules" % q(room_id), A(ALICE), {"join_rule": "public"})
    check("making an existing private room public (state PUT join_rule public) is refused", refused(result, "Public rooms"), result)
    fired = [name for name in ("check_event_for_spam",) if "duo_org_wall: %s refused" % name in server.log()]
    ctx["join_rules_callbacks"] = fired
    print("        (fired: %s)" % ", ".join(fired))
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.join_rules" % q(room_id), A(ALICE), {"join_rule": "invite"})
    check("re-setting join_rules to invite is allowed", result[0] == 200, result)
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.join_rules" % q(room_id), A(ALICE), {"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": general_b}]})
    check("making a room restricted to another org's room is refused", refused(result), result)
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/send/m.room.message/t1" % q(room_id), A(ALICE), {"msgtype": "m.text", "body": "hello"})
    check("an ordinary message is unaffected", result[0] == 200, result)
    result = call(server, "PUT", "/_matrix/client/v3/directory/list/room/" + q(room_id), A(ALICE), {"visibility": "public"})
    check("publishing a room to the directory is refused (user_may_publish_room)", refused(result, "directory"), result)
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/upgrade" % q(room_id), A(ALICE), {"new_version": "10"})
    check("upgrading alice's private room works (initial_state comes in as dicts on v1.161.0)", result[0] == 200, result)

    # Directory.
    found = wait_search(server, A(ALICE), {BOB, ALICE_DUO})
    check("alice's directory search returns her org (bob, her duo)", {BOB, ALICE_DUO} <= found, found)
    check("alice's search never returns org B (carol, carol's duo), even after the refused cross-org join", not ({CAROL, CAROL_DUO} & found), found)
    check("alice's search never returns the service account", ADMIN not in found, found)
    check("alice's search never returns the org-less or malformed accounts", not ({MALLORY, TWO_DOTS} & found), found)
    found_c = search(server, A(CAROL))
    check("carol's search returns only org B", {CAROL_DUO} <= found_c and not ({ALICE, ALICE_DUO, BOB} & found_c), found_c)
    check("an org-less account's search returns nothing", search(server, A(MALLORY)) == set(), None)

    # A limit, recorded rather than hidden: a room holding only the service account has no org to compare with.
    status, fresh = call(server, "POST", "/_matrix/client/v3/createRoom", admin, {"preset": "private_chat", "name": "empty"})
    first = admin_join(fresh["room_id"], CAROL)
    second = admin_join(fresh["room_id"], ALICE)
    check("KNOWN LIMIT: the first person the service account joins into a room holding only itself is accepted (the daemon must pick the right org's room)", first[0] == 200, first)
    check("... and that first joiner then sets the room's org: another org's admin-API join is refused", refused(second, "another organisation"), second)

    # The service account.
    status, extra = call(server, "POST", "/_matrix/client/v3/createRoom", admin, {"preset": "private_chat", "name": "scratch"})
    scratch = extra.get("room_id")
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(scratch), admin, {"user_id": CAROL})
    check("@workspace-admin can invite across orgs (exempt, as designed)", result[0] == 200, result)
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(scratch), admin, {"user_id": ALICE})
    check("@workspace-admin can invite into the same room (exempt)", result[0] == 200, result)
    admin_sees = search(server, admin)
    check("@workspace-admin's own directory search sees every org", {ALICE, CAROL} <= admin_sees, admin_sees)
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.join_rules" % q(scratch), admin, {"join_rule": "invite"})
    check("@workspace-admin keeps sending state events", result[0] == 200, result)
    status, out = call(server, "POST", "/_matrix/client/v3/createRoom", admin, {"visibility": "public", "preset": "public_chat", "name": "admin-public"})
    check("Synapse never asks the module about a server admin's room creation (a public room by the admin is allowed: never promote a person)", status == 200, out)


def phase_control_no_module(server, admin, actors, ctx):
    print("\nPhase 2 (control): NO module, search_all_users true. The checks above would fail without the wall.")
    found = wait_search(server, actors.tokens[ALICE], {BOB, CAROL})
    check("control: alice finds carol in the directory without the module", CAROL in found, found)
    status, room = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"preset": "private_chat", "name": "control"})
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room["room_id"]), actors.tokens[ALICE], {"user_id": CAROL})
    check("control: alice can invite carol without the module", result[0] == 200, result)
    result = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"visibility": "public", "name": "control-public"})
    check("control: alice can create a public room without the module", result[0] == 200, result)


def phase_module_search_all(server, admin, actors, ctx):
    print("\nPhase 3: module loaded, search_all_users TRUE (the module alone has to hide other orgs)")
    found = wait_search(server, actors.tokens[ALICE], {BOB})
    check("with search_all_users true the module still hides org B and the service account", not ({CAROL, CAROL_DUO, ADMIN} & found) and BOB in found, found)
    found_c = search(server, actors.tokens[CAROL])
    check("carol likewise sees only org B", not ({ALICE, BOB, ALICE_DUO, ADMIN} & found_c), found_c)
    check("the service account sees everyone", {ALICE, CAROL} <= search(server, admin), None)
    # A restricted rule pointing at a room that mixes orgs (the control phase left carol invited into alice's room).
    status, room = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"preset": "private_chat", "name": "mixed"})
    ctx["mixed"] = room.get("room_id")


def phase_faulty(server, admin, actors, ctx):
    from_faulty = "duo_org_wall"  # noqa: F841
    print("\nPhase 4: the real module with its room-state read and directory decision forced to raise")
    A = lambda user_id: actors.tokens[user_id]  # noqa: E731
    status, room = call(server, "POST", "/_matrix/client/v3/createRoom", A(ALICE), {"preset": "private_chat", "name": "fault"})
    check("(room creation without a state read still works: same-org invite path)", status == 200, room)
    call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room["room_id"]), A(ALICE), {"user_id": BOB})
    result = call(server, "POST", "/_matrix/client/v3/join/" + q(room["room_id"]), A(BOB), {})
    check("a join whose state read raises is refused, not allowed (fails closed)", refused(result, "cannot be checked"), result)
    result = call(server, "POST", "/_matrix/client/v3/createRoom", A(ALICE), {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": ctx["space_a"]}]}}]})
    check("a create-room whose state read raises is refused (fails closed)", refused(result, "cannot be checked"), result)
    check("a directory search whose decision raises returns nothing (hidden, fails closed)", search(server, A(ALICE)) == set(), None)
    log = server.log()
    sys.path.insert(0, MODULES_DIR)
    from faulty import MARKER
    check("the log names the error class", "failed closed (RuntimeError)" in log)
    check("the log never carries the exception's message", MARKER not in log)


def phase_raising(server, admin, actors, ctx):
    print("\nPhase 5: a bare module whose callbacks raise (what Synapse does with an uncaught error)")
    A = lambda user_id: actors.tokens[user_id]  # noqa: E731
    status, out = call(server, "POST", "/_matrix/client/v3/createRoom", A(ALICE), {"preset": "private_chat", "name": "raise"})
    check("create room with a raising user_may_create_room does not succeed (status %s)" % status, status >= 400, out)
    ctx["raising_create"] = status
    status, out = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(ctx["mixed"]), A(ALICE), {"user_id": BOB})
    check("invite with a raising user_may_invite does not succeed (status %s)" % status, status >= 400, out)
    ctx["raising_invite"] = status
    status, out = call(server, "POST", "/_matrix/client/v3/join/" + q(ctx["mixed"]), A(BOB), {})
    check("join with a raising user_may_join_room does not succeed (status %s)" % status, status >= 400, out)
    ctx["raising_join"] = status
    status, out = call(server, "POST", "/_matrix/client/v3/user_directory/search", A(ALICE), {"search_term": "Wall", "limit": 50})
    check("directory search with a raising check_username_for_spam does not answer with results (status %s)" % status, status >= 400, out)
    ctx["raising_search"] = status


def bootstrap_admin(server):
    env = {**os.environ, "PORT": str(server.port), "SYNAPSE_SERVER_NAME": SERVER, "SYNAPSE_REGISTRATION_SHARED_SECRET": server.secret, "SYNAPSE_ADMIN_PASSWORD": server.admin_password}
    out = subprocess.run([sys.executable, os.path.join(SYNAPSE_DIR, "create_admin.py")], env=env, capture_output=True, text=True)
    assert out.returncode == 0, "create_admin.py failed: " + out.stderr[-200:]
    return out.stdout.strip()


def serve():
    import signal

    workdir = tempfile.mkdtemp(prefix="duo-org-wall-")
    server = Server(workdir, free_port())
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.start("serve")
        path = os.path.join(workdir, "serve.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"base": server.base, "adminToken": bootstrap_admin(server), "serverName": SERVER}, handle)
        print("READY " + path, flush=True)
        while True:
            time.sleep(3600)
    finally:
        server.stop()


def main():
    if "--serve" in sys.argv:
        return serve()
    workdir = tempfile.mkdtemp(prefix="duo-org-wall-")
    server = Server(workdir, free_port())
    ctx, actors = {}, Actors(server)
    print("work dir: " + workdir)
    try:
        server.start("1-main")
        admin = bootstrap_admin(server)
        for user in NAMES:
            actors.create(user, admin)
        phase_main(server, admin, actors, ctx)
        server.stop()
        server.start("2-control", module=None, search_all_users=True)
        phase_control_no_module(server, admin, actors, ctx)
        server.stop()
        server.start("3-search-all", search_all_users=True)
        phase_module_search_all(server, admin, actors, ctx)
        server.stop()
        server.start("4-faulty", module="faulty.FaultyWall")
        sys.path.insert(0, HERE)
        phase_faulty(server, admin, actors, ctx)
        server.stop()
        server.start("5-raising", module="faulty.RaisingModule")
        phase_raising(server, admin, actors, ctx)
    finally:
        server.stop()
    failed = [name for name, ok, _ in results if not ok]
    print("\n%d checks, %d failed" % (len(results), len(failed)))
    print("observed: " + json.dumps({key: ctx[key] for key in ("join_rules_callbacks", "raising_create", "raising_invite", "raising_join", "raising_search", "invite_state_types") if key in ctx}))
    for name in failed:
        print("FAILED: " + name)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
