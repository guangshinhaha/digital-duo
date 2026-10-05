"""Unit tests of the Synapse glue with a stand-in `synapse` (no Synapse needed).

The real thing, against a running Synapse, is tests/real_synapse.py. These pin what
does not need one: what each callback returns, that an error inside fails closed
and is logged by class name only, and the registration itself.
"""
import asyncio
import logging
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def install_stub_synapse():
    class Codes:
        FORBIDDEN = "M_FORBIDDEN"

    class ConfigError(Exception):
        pass

    module_api = types.ModuleType("synapse.module_api")
    module_api.NOT_SPAM = "NOT_SPAM"
    module_api.ModuleApi = object
    errors = types.ModuleType("synapse.module_api.errors")
    errors.Codes, errors.ConfigError = Codes, ConfigError
    package = types.ModuleType("synapse")
    package.module_api = module_api
    module_api.errors = errors
    sys.modules.update({"synapse": package, "synapse.module_api": module_api, "synapse.module_api.errors": errors})
    return Codes, ConfigError


CODES, CONFIG_ERROR = install_stub_synapse()
from duo_org_wall import module  # noqa: E402

ADMIN = "@workspace-admin:duo"
A1, A2, B1 = "@orga1111.alice:duo", "@orga1111.bob:duo", "@orgb2222.carol:duo"
FORBIDDEN = CODES.FORBIDDEN


class Event:
    def __init__(self, membership, key):
        self.content, self.state_key = {"membership": membership}, key


class StateEvent:
    def __init__(self, sender, content):
        self.sender, self.content = sender, content


class FakeApi:
    """`rooms`: room id -> {user: membership}. `state`: room id -> {(type, state_key): (sender, content)} for other state."""

    def __init__(self, rooms=None, error=None, state=None):
        self.callbacks, self.rooms, self.error, self.asked, self.state = {}, rooms or {}, error, [], state or {}

    def register_spam_checker_callbacks(self, **callbacks):
        self.callbacks = callbacks

    async def get_room_state(self, room_id, event_filter=None):
        self.asked.append((room_id, list(event_filter)))
        if self.error:
            raise self.error
        everything = {("m.room.member", user): Event(membership, user) for user, membership in self.rooms.get(room_id, {}).items()}
        everything.update({key: StateEvent(*value) for key, value in self.state.get(room_id, {}).items()})
        # As Synapse filters: a None state key is every event of that type.
        return {key: event for key, event in everything.items() if any(key[0] == t and (k is None or key[1] == k) for t, k in event_filter)}


def build(rooms=None, error=None, state=None):
    api = FakeApi(rooms, error, state)
    module.DuoOrgWall(module.DuoOrgWall.parse_config({"server_name": "duo", "service_accounts": [ADMIN]}), api)
    return api


def run(coro):
    return asyncio.run(coro)


def refusal(result, sentence=None):
    return isinstance(result, tuple) and result[0] == FORBIDDEN and isinstance(result[1], dict) and (sentence is None or sentence in result[1]["error"])


class Registration(unittest.TestCase):
    def test_registers_every_callback_the_wall_needs_and_no_experimental_one(self):
        self.assertEqual(
            set(build().callbacks),
            {"user_may_invite", "user_may_join_room", "user_may_create_room", "user_may_publish_room", "user_may_send_3pid_invite", "check_event_for_spam", "check_username_for_spam"},
        )

    def test_synapse_counts_parameters_to_pass_the_requester_and_the_room_config(self):
        import inspect

        callbacks = build().callbacks
        self.assertEqual(len(inspect.signature(callbacks["check_username_for_spam"]).parameters), 2)
        self.assertEqual(len(inspect.signature(callbacks["user_may_create_room"]).parameters), 2)

    def test_a_bad_config_stops_the_server_from_starting(self):
        with self.assertRaises(CONFIG_ERROR):
            module.DuoOrgWall.parse_config({"server_name": "duo"})


class Verdicts(unittest.TestCase):
    def test_allowed_is_not_spam_and_refused_is_forbidden_with_a_sentence(self):
        cb = build({"!r:duo": {A2: "join", ADMIN: "join"}}).callbacks
        self.assertEqual(run(cb["user_may_invite"](A1, A2, "!r:duo")), "NOT_SPAM")
        self.assertTrue(refusal(run(cb["user_may_invite"](A1, B1, "!r:duo")), "across organisations"))
        self.assertEqual(run(cb["user_may_join_room"](A1, "!r:duo", True)), "NOT_SPAM")
        self.assertTrue(refusal(run(cb["user_may_join_room"](B1, "!r:duo", True)), "another organisation"))

    def test_the_service_account_never_reads_room_state(self):
        api = build()
        self.assertEqual(run(api.callbacks["user_may_join_room"](ADMIN, "!r:duo", False)), "NOT_SPAM")
        self.assertEqual(api.asked, [])

    def test_create_room_prefetches_only_restricted_rooms(self):
        api = build({"!space:duo": {A1: "join", ADMIN: "join"}})
        self.assertEqual(run(api.callbacks["user_may_create_room"](A1, {"preset": "private_chat"})), "NOT_SPAM")
        self.assertEqual(api.asked, [])
        config = {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": "!space:duo"}]}}]}
        self.assertEqual(run(api.callbacks["user_may_create_room"](A1, config)), "NOT_SPAM")
        self.assertEqual(api.asked, [("!space:duo", [("m.room.member", None)])])
        self.assertTrue(refusal(run(api.callbacks["user_may_create_room"](B1, config)), "Public rooms"))
        self.assertTrue(refusal(run(api.callbacks["user_may_create_room"](A1, {"visibility": "public"})), "Public rooms"))

    def test_publish_and_3pid(self):
        cb = build().callbacks
        self.assertTrue(refusal(run(cb["user_may_publish_room"](A1, "!r:duo")), "directory"))
        self.assertTrue(refusal(run(cb["user_may_send_3pid_invite"](A1, "email", "a@b.c", "!r:duo")), "email or phone"))
        self.assertEqual(run(cb["user_may_publish_room"](ADMIN, "!r:duo")), "NOT_SPAM")

    def test_a_member_entry_in_initial_state_is_refused_without_reading_any_room(self):
        api = build()
        entry = {"type": "m.room.member", "state_key": B1, "content": {"membership": "invite", "reason": "hi"}}
        result = run(api.callbacks["user_may_create_room"](A1, {"initial_state": [entry]}))
        self.assertTrue(refusal(result, "across organisations"))
        self.assertEqual(api.asked, [])
        self.assertEqual(run(api.callbacks["user_may_create_room"](ADMIN, {"initial_state": [entry]})), "NOT_SPAM")

    def test_create_room_refuses_a_world_readable_room_but_not_the_presets_guest_access(self):
        cb = build().callbacks
        world = {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "world_readable"}}
        self.assertTrue(refusal(run(cb["user_may_create_room"](A1, {"initial_state": [world]})), "Public rooms"))
        # A room upgrade copies the guest_access the private_chat preset wrote (can_join): it must still work.
        guest = {"type": "m.room.guest_access", "state_key": "", "content": {"guest_access": "can_join"}}
        self.assertEqual(run(cb["user_may_create_room"](A1, {"initial_state": [guest]})), "NOT_SPAM")
        shared = {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "shared"}}
        self.assertEqual(run(cb["user_may_create_room"](A1, {"initial_state": [shared]})), "NOT_SPAM")

    def test_a_join_reads_the_room_state_once(self):
        api = build({"!r:duo": {A2: "join", ADMIN: "join"}})
        self.assertEqual(run(api.callbacks["user_may_join_room"](A1, "!r:duo", True)), "NOT_SPAM")
        self.assertEqual(api.asked, [("!r:duo", [("m.room.member", None)])])

    def test_event_check_looks_at_join_rules_history_visibility_and_guest_access(self):
        cb = build().callbacks

        class Ev:
            def __init__(self, type, sender, content):
                self.type, self.sender, self.content = type, sender, content

        self.assertEqual(run(cb["check_event_for_spam"](Ev("m.room.message", A1, {"body": "hi"}))), "NOT_SPAM")
        self.assertEqual(run(cb["check_event_for_spam"](Ev("m.room.join_rules", A1, {"join_rule": "invite"}))), "NOT_SPAM")
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev("m.room.join_rules", A1, {"join_rule": "public"}))), "Public rooms"))
        self.assertEqual(run(cb["check_event_for_spam"](Ev("m.room.join_rules", ADMIN, {"join_rule": "public"}))), "NOT_SPAM")
        # Other state that makes a room readable or joinable by everyone.
        for value in ("shared", "joined", "invited"):
            self.assertEqual(run(cb["check_event_for_spam"](Ev("m.room.history_visibility", A1, {"history_visibility": value}))), "NOT_SPAM")
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev("m.room.history_visibility", A1, {"history_visibility": "world_readable"}))), "Public rooms"))
        self.assertEqual(run(cb["check_event_for_spam"](Ev("m.room.history_visibility", ADMIN, {"history_visibility": "world_readable"}))), "NOT_SPAM")
        self.assertEqual(run(cb["check_event_for_spam"](Ev("m.room.guest_access", A1, {"guest_access": "forbidden"}))), "NOT_SPAM")
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev("m.room.guest_access", A1, {"guest_access": "can_join"}))), "Public rooms"))

    def test_space_child_links_read_the_child_and_the_existing_link(self):
        space, channel, group = "!space:duo", "!channel:duo", "!group:duo"
        open_to_space = {"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": space}]}
        api = build(
            rooms={space: {ADMIN: "join", A1: "join", A2: "join"}, channel: {A1: "join"}, group: {A1: "join", A2: "join"}, "!general:duo": {ADMIN: "join", A1: "join"}},
            state={
                space: {("m.space.child", "!general:duo"): (ADMIN, {"via": ["duo"]})},
                channel: {("m.room.join_rules", ""): (A1, open_to_space), ("m.room.history_visibility", ""): (A1, {"history_visibility": "shared"})},
                group: {("m.room.join_rules", ""): (A1, {"join_rule": "invite"})},
            },
        )
        cb = api.callbacks

        class Ev:
            def __init__(self, sender, key, content, room_id=space):
                self.type, self.sender, self.content, self.room_id, self._key = "m.space.child", sender, content, room_id, key

            def get_state_key(self):
                return self._key

        link = {"via": ["duo"]}
        self.assertEqual(run(cb["check_event_for_spam"](Ev(A1, channel, link))), "NOT_SPAM")
        self.assertIn((space, [("m.space.child", channel)]), api.asked)
        self.assertIn((channel, [("m.room.join_rules", ""), ("m.room.history_visibility", ""), ("m.room.member", None)]), api.asked)
        self.assertIn((space, [("m.room.member", None)]), api.asked)  # the allow entry's orgs
        # An invite-only room (every room made before #274) is not listed; nor is a room the sender is not in.
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev(A1, group, link))), "can be listed"))
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev(A2, channel, link))), "can be listed"))
        # Another org's account cannot list it, nor can a member touch the service account's #general link.
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev(B1, channel, link))), "can be listed"))
        self.assertTrue(refusal(run(cb["check_event_for_spam"](Ev(A1, "!general:duo", {}))), "Only the person who listed"))
        # Removing your own (or a never-made) link is fine whatever the room is; the service account is never judged (nor read for).
        self.assertEqual(run(cb["check_event_for_spam"](Ev(A1, group, {}))), "NOT_SPAM")
        before = len(api.asked)
        self.assertEqual(run(cb["check_event_for_spam"](Ev(ADMIN, group, link))), "NOT_SPAM")
        self.assertEqual(len(api.asked), before)
        # A timeline (non-state) event of this type links nothing.
        self.assertEqual(run(cb["check_event_for_spam"](Ev(A1, None, link))), "NOT_SPAM")

    def test_a_room_with_no_history_event_reads_as_shared(self):
        space, channel = "!space:duo", "!channel:duo"
        open_to_space = {"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": space}]}
        api = build(rooms={space: {A1: "join"}, channel: {A1: "join"}}, state={channel: {("m.room.join_rules", ""): (A1, open_to_space)}})

        class Ev:
            type, sender, content, room_id = "m.space.child", A1, {"via": ["duo"]}, space

            def get_state_key(self):
                return channel

        self.assertEqual(run(api.callbacks["check_event_for_spam"](Ev())), "NOT_SPAM")

    def test_directory_returns_a_boolean_true_to_hide(self):
        cb = build().callbacks
        self.assertIs(run(cb["check_username_for_spam"]({"user_id": A2, "display_name": "x", "avatar_url": None}, A1)), False)
        self.assertIs(run(cb["check_username_for_spam"]({"user_id": B1}, A1)), True)
        self.assertIs(run(cb["check_username_for_spam"]({"user_id": ADMIN}, A1)), True)
        self.assertIs(run(cb["check_username_for_spam"]({}, A1)), True)


SECRET = "SECRET-room-and-user-names-!x:duo"


class FailsClosed(unittest.TestCase):
    def test_a_failing_state_read_refuses_and_logs_only_the_class_name(self):
        cb = build(error=RuntimeError(SECRET)).callbacks
        with self.assertLogs("duo_org_wall.module", level="ERROR") as logged:
            join = run(cb["user_may_join_room"](A1, "!x:duo", True))
        self.assertTrue(refusal(join, "cannot be checked"))
        self.assertIn("RuntimeError", "\n".join(logged.output))
        self.assertNotIn(SECRET, "\n".join(logged.output))
        config = {"initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "restricted", "allow": [{"room_id": "!x:duo"}]}}]}
        with self.assertLogs("duo_org_wall.module", level="ERROR"):
            self.assertTrue(refusal(run(cb["user_may_create_room"](A1, config)), "cannot be checked"))

        class Link:
            type, sender, content, room_id = "m.space.child", A1, {"via": ["duo"]}, "!space:duo"

            def get_state_key(self):
                return "!x:duo"

        with self.assertLogs("duo_org_wall.module", level="ERROR") as logged:
            self.assertTrue(refusal(run(cb["check_event_for_spam"](Link())), "cannot be checked"))
        self.assertNotIn(SECRET, "\n".join(logged.output))

    def test_a_failing_decision_refuses_or_hides(self):
        api = build()
        # Reach into the wall the callbacks are bound to and break each decision in turn.
        wall = api.callbacks["user_may_invite"].__self__._wall

        def boom(*args, **kwargs):
            raise ValueError(SECRET)

        for name, callback, args in [
            ("may_invite", "user_may_invite", (A1, A2, "!r:duo")),
            ("may_create_room", "user_may_create_room", (A1, {})),
            ("may_publish", "user_may_publish_room", (A1, "!r:duo")),
            ("may_send_3pid_invite", "user_may_send_3pid_invite", (A1, "email", "a", "!r:duo")),
        ]:
            setattr(wall, name, boom)
            with self.assertLogs("duo_org_wall.module", level="ERROR") as logged:
                self.assertTrue(refusal(run(api.callbacks[callback](*args)), "cannot be checked"), callback)
            self.assertNotIn(SECRET, "\n".join(logged.output))
        wall.hide_from_directory = boom
        with self.assertLogs("duo_org_wall.module", level="ERROR"):
            self.assertIs(run(api.callbacks["check_username_for_spam"]({"user_id": A2}, A1)), True)

    def test_a_failing_event_check_refuses(self):
        cb = build().callbacks

        class Broken:
            @property
            def type(self):
                raise KeyError(SECRET)

        with self.assertLogs("duo_org_wall.module", level="ERROR") as logged:
            self.assertTrue(refusal(run(cb["check_event_for_spam"](Broken())), "cannot be checked"))
        self.assertNotIn(SECRET, "\n".join(logged.output))

    def test_refusals_are_logged_without_ids(self):
        cb = build().callbacks
        with self.assertLogs("duo_org_wall.module", level="INFO") as logged:
            run(cb["user_may_invite"](A1, B1, "!r:duo"))
        text = "\n".join(logged.output)
        self.assertIn("user_may_invite refused", text)
        for private in (A1, B1, "orga1111", "orgb2222"):
            self.assertNotIn(private, text)


if __name__ == "__main__":
    logging.disable(logging.NOTSET)
    unittest.main()
