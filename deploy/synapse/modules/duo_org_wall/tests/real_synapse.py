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

`--mutate NAME` runs every phase against a copy of the module with one deliberate defect (`--mutate list` names them):
the run must FAIL at least one check (a wall check that cannot notice its wall being weakened is worthless), and the
exit status is 0 when it did. `--mutate-all` runs each in turn, four at a time, and prints how many checks each broke.
A mutation that breaks nothing here is listed in UNIT_TEST_ONLY: only the unit tests can see it.

Exit status 0 only if every check passed. Nothing secret is printed.
"""
import itertools
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
MODULES_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))  # replaced by a mutated copy under --mutate
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

# name -> (what it breaks, [(file under duo_org_wall/, exact text, replacement), ...]). Each is one line of the module made wrong.
MUTATIONS = {
    "invite-off": ("cross-org invites allowed", [("rules.py", "return None if self._same_org(inviter, invitee) else ERR_INVITE", "return None")]),
    "join-off": ("a join is never refused for another org's member", [("rules.py", "if self.org_of(member) != org:", "if False:")]),
    "join-ignores-invited": ("an invited (not joined) member does not count in may_join", [("rules.py", 'if member == user_id or membership not in ("join", "invite"):', 'if member == user_id or membership not in ("join",):')]),
    "two-dots": ("an id with two dots parses as an org", [("rules.py", 'r"(?:duo-)?([a-z0-9]+)\\.([a-z0-9]+)"', 'r"(?:duo-)?([a-z0-9]+)\\.(.+)"')]),
    "newline-anchor": ("`$` instead of fullmatch: a trailing newline still parses", [
        ("rules.py", "_LOCALPART.fullmatch(id_match.group(1))", 're.match(_LOCALPART.pattern + "$", id_match.group(1))'),
        ("rules.py", "_USER_ID.fullmatch(user_id)", 're.match(_USER_ID.pattern + "$", user_id)'),
    ]),
    "create-invite-list-off": ("createRoom `invite` list not checked", [("rules.py", "if not self._same_org(user_id, invitee):", "if False:")]),
    "create-public-off": ("createRoom visibility not checked", [("rules.py", 'if config.get("visibility", "private") != "private":', "if False:")]),
    "create-member-entry-off": ("createRoom initial_state member entries not refused", [("rules.py", 'if entry.get("type") == MEMBER_EVENT:', "if False:")]),
    "create-join-rules-off": ("createRoom initial_state join rules not checked", [("rules.py", 'if entry.get("type") == JOIN_RULES_EVENT:', "if False:")]),
    "create-history-off": ("createRoom initial_state history visibility not checked", [("rules.py", 'elif entry.get("type") == HISTORY_EVENT:', "elif False:")]),
    "history-world-readable-ok": ("world_readable accepted everywhere", [("rules.py", 'READABLE_HISTORY = ("invited", "joined", "shared")', 'READABLE_HISTORY = ("invited", "joined", "shared", "world_readable")')]),
    "event-join-rules-off": ("a client-sent join-rules event is not checked", [("module.py", "if event.type == rules.JOIN_RULES_EVENT:", "if False:")]),
    "event-history-off": ("a client-sent history-visibility / guest-access event is not checked", [("module.py", "if event.type in rules.READABILITY_EVENTS:", "if False:")]),
    "publish-off": ("publishing to the room directory allowed", [("rules.py", "return None if self.is_service(user_id) else ERR_PUBLISH", "return None")]),
    "3pid-off": ("3pid invites on an existing room allowed", [("rules.py", "return None if self.is_service(user_id) else ERR_3PID", "return None")]),
    "directory-off": ("the directory filter shows everyone", [("module.py", 'return self._wall.hide_from_directory(user_profile.get("user_id"), requester_id)', "return False")]),
    "fails-open": ("an error inside the module allows instead of refusing", [("module.py", 'return Codes.FORBIDDEN, {"error": "This request cannot be checked right now."}', "return NOT_SPAM")]),
}
# Mutations no check in this file can see (only the unit tests): not reachable through Synapse's HTTP API.
UNIT_TEST_ONLY = {"newline-anchor"}  # Synapse never lets an id with a newline exist, so a real request cannot carry one


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


def search_raw(server, token, term, limit=50):
    status, body = call(server, "POST", "/_matrix/client/v3/user_directory/search", token, {"search_term": term, "limit": limit})
    assert status == 200, status
    return body


_sync_counter = itertools.count(1)


def invites_of(server, token):
    """Room ids the account is currently invited to (a full /sync).

    Synapse caches an identical sync response for a while (sync_response_cache_duration), which would hide an invite that
    arrived between two calls; a different `timeout` (a millisecond or so, as nothing is pending) is a different cache key.
    """
    status, sync = call(server, "GET", "/_matrix/client/v3/sync?timeout=%d" % next(_sync_counter), token)
    assert status == 200, status
    return set(sync.get("rooms", {}).get("invite", {}))


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
    check("service account creates private org Space and #general (admin skips user_may_create_room)", len({space_a, general_a, space_b, general_b}) == 4 and all(room.startswith("!") for room in ctx.values()), ctx)

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
    # A FRESH room holding only alice: general_a is already poisoned by carol's pending invite above, which would refuse
    # this join whatever the parse said. Here the only thing that can refuse it is the id's parse (loosen it and it joins).
    status, fresh_a = call(server, "POST", "/_matrix/client/v3/createRoom", admin, {"preset": "private_chat", "name": "twodots"})
    seeded = admin_join(fresh_a["room_id"], ALICE)
    check("(setup) a fresh room holding only alice's org", status == 200 and seeded[0] == 200, seeded)
    result = admin_join(fresh_a["room_id"], TWO_DOTS)
    check("admin-API join of a malformed id (two dots) into an org room is refused, in a room nothing else poisons", refused(result, "does not belong"), result)

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
    joined = lambda: sorted(call(server, "GET", "/_matrix/client/v3/joined_rooms", A(ALICE))[1]["joined_rooms"])  # noqa: E731
    rooms_before = joined()
    result = make_room(ALICE, {"is_direct": True, "invite": [CAROL]})
    check("a DM to another org is refused", refused(result, "across organisations"), result)
    check("... and no room is left behind (user_may_invite alone would refuse the invite only after Synapse made the room)", joined() == rooms_before, set(joined()) - set(rooms_before))
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

    # initial_state is written without any callback but ours: a member entry would deliver an invite.
    carol_invites = invites_of(server, A(CAROL))
    member_entry = lambda who, membership: [{"type": "m.room.member", "state_key": who, "content": {"membership": membership, "reason": "from org A"}}]  # noqa: E731
    result = make_room(ALICE, {"initial_state": member_entry(CAROL, "invite")})
    check("createRoom with an initial_state m.room.member INVITE for another org's user is refused (Synapse would write it with no invite check)", refused(result, "across organisations"), result)
    check("... and carol's /sync shows no new invite (nothing was delivered)", invites_of(server, A(CAROL)) == carol_invites, invites_of(server, A(CAROL)) - carol_invites)
    result = make_room(ALICE, {"initial_state": member_entry(BOB, "invite")})
    check("createRoom with any initial_state m.room.member entry is refused, even a same-org one (a fresh room needs none)", refused(result, "across organisations"), result)
    result = make_room(ALICE, {"initial_state": member_entry(CAROL, "join")})
    check("createRoom with an initial_state m.room.member JOIN for another org's user is refused", refused(result), result)

    # Other ways to make a room readable or joinable by everyone, in creation and afterwards.
    hidden = lambda value: [{"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": value}}]  # noqa: E731
    guests = lambda value: [{"type": "m.room.guest_access", "state_key": "", "content": {"guest_access": value}}]  # noqa: E731
    result = make_room(ALICE, {"initial_state": hidden("world_readable")})
    check("createRoom with initial_state history_visibility world_readable is refused", refused(result, "Public rooms"), result)
    for value in ("invited", "joined", "shared"):
        result = make_room(ALICE, {"initial_state": hidden(value)})
        check("createRoom with initial_state history_visibility %s is allowed" % value, result[0] == 200, result)
    result = make_room(ALICE, {"initial_state": hidden("bogus")})
    check("createRoom with an unknown history_visibility value is refused (fails closed)", refused(result), result)
    result = make_room(ALICE, {"initial_state": guests("can_join")})
    check("createRoom with initial_state guest_access can_join is NOT judged (the private_chat preset writes it and a room upgrade copies it; guests are off)", result[0] == 200, result)

    # The attack: a private room made world-readable, found by another org through an alias, read with the room id.
    status, peek = make_room(ALICE, {"name": "peek"})
    peek_id = peek["room_id"]
    result = call(server, "PUT", "/_matrix/client/v3/directory/room/" + q("#peek:" + SERVER), A(ALICE), {"room_id": peek_id})
    check("(setup) alice gives the private room an alias", result[0] == 200, result)
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.history_visibility" % q(peek_id), A(ALICE), {"history_visibility": "world_readable"})
    check("a state PUT of history_visibility world_readable into an existing private room is refused", refused(result, "Public rooms"), result)
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.guest_access" % q(peek_id), A(ALICE), {"guest_access": "can_join"})
    check("a state PUT of guest_access can_join into an existing private room is refused", refused(result, "Public rooms"), result)
    # After the attempts above, so a wall that let world_readable through would have this message readable (history is judged per event).
    sent = call(server, "PUT", "/_matrix/client/v3/rooms/%s/send/m.room.message/p1" % q(peek_id), A(ALICE), {"msgtype": "m.text", "body": "org A private words"})
    check("(setup) alice sends a message in the room", sent[0] == 200, sent)
    status, resolved = call(server, "GET", "/_matrix/client/v3/directory/room/" + q("#peek:" + SERVER), A(CAROL))
    check("OBSERVED: carol (org B) resolves the alias to the room id (an alias is not a secret; the room stays unreadable)", status == 200 and resolved.get("room_id") == peek_id, (status, resolved))
    reads = {
        "GET /messages": call(server, "GET", "/_matrix/client/v3/rooms/%s/messages?dir=b&limit=10" % q(peek_id), A(CAROL)),
        "GET /initialSync": call(server, "GET", "/_matrix/client/r0/rooms/%s/initialSync" % q(peek_id), A(CAROL)),
        "GET /state": call(server, "GET", "/_matrix/client/v3/rooms/%s/state" % q(peek_id), A(CAROL)),
    }
    for name, (status, body) in reads.items():
        check("carol, resolving the alias, cannot read the room with %s (403, and no message in the body)" % name, status == 403 and "org A private words" not in json.dumps(body), (status, body))
    for value in ("shared", "joined", "invited"):
        result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.history_visibility" % q(peek_id), A(ALICE), {"history_visibility": value})
        check("a state PUT of history_visibility %s is allowed" % value, result[0] == 200, result)

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
    check("upgrading alice's private room works (initial_state comes in as dicts on v1.161.0; it carries the preset's guest_access can_join and history_visibility shared)", result[0] == 200, result)

    # Directory.
    found = wait_search(server, A(ALICE), {BOB, ALICE_DUO})
    check("alice's directory search returns her org (bob, her duo)", {BOB, ALICE_DUO} <= found, found)
    check("alice's search never returns org B (carol, carol's duo), even after the refused cross-org join", not ({CAROL, CAROL_DUO} & found), found)
    check("alice's search never returns the service account", ADMIN not in found, found)
    check("alice's search never returns the org-less or malformed accounts", not ({MALLORY, TWO_DOTS} & found), found)
    found_c = search(server, A(CAROL))
    check("carol's search returns only org B", {CAROL_DUO} <= found_c and not ({ALICE, ALICE_DUO, BOB} & found_c), found_c)
    check("an org-less account's search returns nothing", search(server, A(MALLORY)) == set(), None)
    # `limited` says whether Synapse cut the list: with the query already scoped to shared rooms (the shipped setting) it must not
    # differ between a term that matches another org and one that matches nobody.
    other_org, nobody = search_raw(server, A(ALICE), "Carol", limit=1), search_raw(server, A(ALICE), "zzzznobody", limit=1)
    check("shipped setting: a limit-1 search for another org's name answers exactly like a search for nobody (no `limited` leak)", other_org == nobody == {"limited": False, "results": []}, (other_org, nobody))

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
    result = call(server, "POST", "/_matrix/client/v3/join/" + q(scratch), A(ALICE), {})
    check("alice cannot accept her invite: the only other person there is carol, INVITED and not joined (an invite counts as membership)", refused(result, "another organisation"), result)
    admin_sees = search(server, admin)
    check("@workspace-admin's own directory search sees every org", {ALICE, CAROL} <= admin_sees, admin_sees)
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.join_rules" % q(scratch), admin, {"join_rule": "invite"})
    check("@workspace-admin keeps sending state events", result[0] == 200, result)
    status, out = call(server, "POST", "/_matrix/client/v3/createRoom", admin, {"visibility": "public", "preset": "public_chat", "name": "admin-public"})
    check("Synapse never asks the module about a server admin's room creation (a public room by the admin is allowed: never promote a person)", status == 200, out)


def login_with_device(server, admin, user_id, display_name):
    """A real password login (the admin-API token has no device, and to-device and key calls need one). Returns (token, device id)."""
    password = secrets.token_hex(24)
    status, _ = call(server, "PUT", "/_synapse/admin/v2/users/" + q(user_id), admin, {"password": password})
    assert status in (200, 201), status
    device_id = "GAP" + secrets.token_hex(4).upper()
    status, body = call(server, "POST", "/_matrix/client/v3/login", None, {"type": "m.login.password", "identifier": {"type": "m.id.user", "user": user_id}, "password": password, "device_id": device_id, "initial_device_display_name": display_name})
    assert status == 200, status
    return body["access_token"], device_id


def phase_known_gaps(server, admin, actors, ctx):
    """Things the wall does NOT stop, asserted as they are today (hosted-workspace.md §6.4).

    Each check passes while the gap is open. If one FAILS, Synapse changed: read what it does now, then
    update §6.4 (and this check). It is not a wall check that regressed.
    """
    name = "Carol's private laptop"
    tokens = {ALICE: login_with_device(server, admin, ALICE, "Alice's laptop"), CAROL: login_with_device(server, admin, CAROL, name)}
    A = lambda user_id: tokens[user_id][0]  # noqa: E731
    carol_device = tokens[CAROL][1]
    print("\nKnown gaps (expectations of what is NOT blocked; a failure here means Synapse changed, not that the wall broke)")
    status, sync = call(server, "GET", "/_matrix/client/v3/sync?timeout=0", A(CAROL))
    since = sync["next_batch"]
    result = call(server, "PUT", "/_matrix/client/v3/sendToDevice/m.test/gap1", A(ALICE), {"messages": {CAROL: {"*": {"hello": "from org A"}}}})
    delivered = []
    for _ in range(20):
        status, sync = call(server, "GET", "/_matrix/client/v3/sync?timeout=0&since=" + q(since), A(CAROL))
        delivered = [event for event in sync.get("to_device", {}).get("events", []) if event.get("type") == "m.test"]
        if delivered:
            break
        time.sleep(0.5)
    check("KNOWN GAP (to-device): alice's sendToDevice to carol, another org, with no shared room, is accepted and delivered (no Synapse callback exists for it)", result[0] == 200 and any(e.get("sender") == ALICE for e in delivered), (result, delivered))
    result = call(server, "POST", "/_matrix/client/v3/keys/upload", A(CAROL), {"device_keys": {"user_id": CAROL, "device_id": carol_device, "algorithms": ["m.megolm.v1.aes-sha2"], "keys": {"curve25519:%s" % carol_device: "AAAA", "ed25519:%s" % carol_device: "BBBB"}, "signatures": {}}})
    check("(setup) carol uploads a device key", result[0] == 200, result)
    status, out = call(server, "POST", "/_matrix/client/v3/keys/query", A(ALICE), {"device_keys": {CAROL: [], "@orgb2222.nobody:" + SERVER: []}})
    device = out.get("device_keys", {}).get(CAROL, {}).get(carol_device, {})
    check("KNOWN GAP (device keys): alice's /keys/query for carol, another org, returns her device id, keys and display name", status == 200 and device.get("unsigned", {}).get("device_display_name") == name and "curve25519:%s" % carol_device in device.get("keys", {}), (status, out))
    status, profile = call(server, "GET", "/_matrix/client/v3/profile/" + q(CAROL), A(ALICE))
    check("(contrast) the same lookup through /profile IS walled (limit_profile_requests_to_users_who_share_rooms)", status == 403, (status, profile))


def phase_control_no_module(server, admin, actors, ctx):
    print("\nPhase 2 (control): NO module, search_all_users true. The checks above would fail without the wall.")
    found = wait_search(server, actors.tokens[ALICE], {BOB, CAROL})
    check("control: alice finds carol in the directory without the module", CAROL in found, found)
    status, room = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"preset": "private_chat", "name": "control"})
    result = call(server, "POST", "/_matrix/client/v3/rooms/%s/invite" % q(room["room_id"]), actors.tokens[ALICE], {"user_id": CAROL})
    check("control: alice can invite carol without the module", result[0] == 200, result)
    result = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"visibility": "public", "name": "control-public"})
    check("control: alice can create a public room without the module", result[0] == 200, result)
    before = invites_of(server, actors.tokens[CAROL])
    status, room = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"preset": "private_chat", "initial_state": [{"type": "m.room.member", "state_key": CAROL, "content": {"membership": "invite"}}]})
    check("control: without the module a createRoom initial_state member invite reaches carol", status == 200 and room["room_id"] in invites_of(server, actors.tokens[CAROL]) - before, (status, room))
    status, room = call(server, "POST", "/_matrix/client/v3/createRoom", actors.tokens[ALICE], {"preset": "private_chat", "name": "control-peek"})
    peek = room["room_id"]
    call(server, "PUT", "/_matrix/client/v3/directory/room/" + q("#controlpeek:" + SERVER), actors.tokens[ALICE], {"room_id": peek})
    result = call(server, "PUT", "/_matrix/client/v3/rooms/%s/state/m.room.history_visibility" % q(peek), actors.tokens[ALICE], {"history_visibility": "world_readable"})
    sent = call(server, "PUT", "/_matrix/client/v3/rooms/%s/send/m.room.message/c1" % q(peek), actors.tokens[ALICE], {"msgtype": "m.text", "body": "control words"})
    status, resolved = call(server, "GET", "/_matrix/client/v3/directory/room/" + q("#controlpeek:" + SERVER), actors.tokens[CAROL])
    status, body = call(server, "GET", "/_matrix/client/v3/rooms/%s/messages?dir=b&limit=10" % q(peek), actors.tokens[CAROL])
    check("control: without the module a world_readable private room is readable by another org through its alias (the attack the checks above stop)", result[0] == 200 and status == 200 and "control words" in json.dumps(body), (sent, result, status, body))


def phase_module_search_all(server, admin, actors, ctx):
    print("\nPhase 3: module loaded, search_all_users TRUE (the module alone has to hide other orgs)")
    found = wait_search(server, actors.tokens[ALICE], {BOB})
    check("with search_all_users true the module still hides org B and the service account", not ({CAROL, CAROL_DUO, ADMIN} & found) and BOB in found, found)
    found_c = search(server, actors.tokens[CAROL])
    check("carol likewise sees only org B", not ({ALICE, BOB, ALICE_DUO, ADMIN} & found_c), found_c)
    check("the service account sees everyone", {ALICE, CAROL} <= search(server, admin), None)
    other_org, nobody = search_raw(server, actors.tokens[ALICE], "Carol", limit=1), search_raw(server, actors.tokens[ALICE], "zzzznobody", limit=1)
    check("KNOWN GAP (directory `limited`): with search_all_users true the module filters after Synapse applied the limit, so a limit-1 search for another org's name answers limited:true with no results (it is a filter, not a scope; the shipped setting is false)", other_org == {"limited": True, "results": []} and nobody == {"limited": False, "results": []}, (other_org, nobody))
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


def apply_mutation(name, workdir):
    """Points MODULES_DIR at a copy of the module with one defect (each replaced text must be present exactly once)."""
    import shutil

    global MODULES_DIR
    edits = MUTATIONS[name][1]
    target = os.path.join(workdir, "mutant")
    shutil.copytree(os.path.join(MODULES_DIR, "duo_org_wall"), os.path.join(target, "duo_org_wall"), ignore=shutil.ignore_patterns("tests", "__pycache__"))
    for filename, old, new in edits:
        path = os.path.join(target, "duo_org_wall", filename)
        with open(path) as handle:
            text = handle.read()
        if text.count(old) != 1:
            raise SystemExit("mutation %s is stale: %r is in %s %d times (expected 1)" % (name, old, filename, text.count(old)))
        with open(path, "w") as handle:
            handle.write(text.replace(old, new))
    MODULES_DIR = target


def mutate_all():
    from concurrent.futures import ThreadPoolExecutor

    def run(name):
        for _ in range(2):  # a busy machine can make Synapse miss its start-up deadline: once more before calling it an error
            out = subprocess.run([sys.executable, os.path.abspath(__file__), "--mutate", name], capture_output=True, text=True)
            line = [row for row in out.stdout.splitlines() if row.endswith(" checks failed") and row.startswith("MUTATION ")]
            if line or "synapse did not come up" not in out.stderr + out.stdout:
                break
        return name, int(line[0].split(":")[1].split()[0]) if line else -1

    with ThreadPoolExecutor(4) as pool:
        outcome = list(pool.map(run, MUTATIONS))
    bad = []
    print("%-26s %-8s %s" % ("mutation", "failed", "what it breaks"))
    for name, count in outcome:
        note = "  (unit tests only, by design)" if name in UNIT_TEST_ONLY else ""
        print("%-26s %-8s %s%s" % (name, "ERROR" if count < 0 else count, MUTATIONS[name][0], note))
        if count < 0 or (count == 0 and name not in UNIT_TEST_ONLY) or (count > 0 and name in UNIT_TEST_ONLY):
            bad.append(name)
    print("undetected or errored: " + (", ".join(bad) if bad else "none"))
    return 1 if bad else 0


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
    mutation = None
    if "--mutate-all" in sys.argv:
        sys.exit(mutate_all())
    if "--mutate" in sys.argv:
        mutation = sys.argv[sys.argv.index("--mutate") + 1] if len(sys.argv) > sys.argv.index("--mutate") + 1 else "list"
        if mutation == "list":
            for name, (what, _) in MUTATIONS.items():
                print("%-26s %s%s" % (name, what, "  (unit tests only)" if name in UNIT_TEST_ONLY else ""))
            return
        if mutation not in MUTATIONS:
            raise SystemExit("unknown mutation %r; `--mutate list` names them" % mutation)
    workdir = tempfile.mkdtemp(prefix="duo-org-wall-")
    if mutation:
        apply_mutation(mutation, workdir)
    server = Server(workdir, free_port())
    ctx, actors = {}, Actors(server)
    print("work dir: " + workdir)
    try:
        server.start("1-main")
        admin = bootstrap_admin(server)
        for user in NAMES:
            actors.create(user, admin)
        phase_main(server, admin, actors, ctx)
        phase_known_gaps(server, admin, actors, ctx)
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
    if mutation:
        print("MUTATION %s: %d checks failed" % (mutation, len(failed)))
        sys.exit(0 if failed else 1)  # 0 = the harness noticed the defect
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
