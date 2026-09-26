"""Unit tests of the org wall's decisions (no Synapse needed): python -m unittest discover."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from duo_org_wall import rules  # noqa: E402

S = "duo"
ADMIN = "@workspace-admin:duo"
A1, A1_DUO, A2 = "@orga1111.alice:duo", "@duo-orga1111.alice:duo", "@orga1111.bob:duo"
B1, B1_DUO = "@orgb2222.carol:duo", "@duo-orgb2222.carol:duo"
ROOT_DUO = "@duo-default.root:duo"
wall = rules.OrgWall(S, [ADMIN])


class OrgOf(unittest.TestCase):
    def test_person_and_duo_share_their_org(self):
        self.assertEqual(wall.org_of(A1), "orga1111")
        self.assertEqual(wall.org_of(A1_DUO), "orga1111")
        self.assertEqual(wall.org_of(ROOT_DUO), "default")
        self.assertEqual(wall.org_of("@default.root:duo"), "default")

    def test_ids_with_no_clear_org_have_none(self):
        for bad in [
            ADMIN,  # no dot: the service account has no org
            "@mallory:duo",
            "@orga1111.a.b:duo",  # two dots: not ours, and the record's first-dot parse would give an org
            "@.alice:duo",
            "@orga1111.:duo",
            "@Orga1111.alice:duo",  # uppercase
            "@duo-duo-orga1111.alice:duo",
            "@orga1111.alice:other",  # another server
            "@orga1111.alice",
            "orga1111.alice:duo",
            "@orga-1111.alice:duo",
            "@orga1111.alice:duo:extra",
            "",
            None,
            42,
            ["@orga1111.alice:duo"],
        ]:
            self.assertIsNone(wall.org_of(bad), repr(bad))

    def test_an_org_id_that_looks_like_the_duo_prefix_is_still_an_org(self):
        self.assertEqual(wall.org_of("@duo.alice:duo"), "duo")
        self.assertEqual(wall.org_of("@duo-duo.alice:duo"), "duo")


class Invites(unittest.TestCase):
    def test_same_org_only(self):
        self.assertIsNone(wall.may_invite(A1, A2))
        self.assertIsNone(wall.may_invite(A1, A1_DUO))
        self.assertIsNone(wall.may_invite(A1_DUO, A1))
        self.assertEqual(wall.may_invite(A1, B1), rules.ERR_INVITE)
        self.assertEqual(wall.may_invite(A1, B1_DUO), rules.ERR_INVITE)

    def test_no_org_means_no_invites_either_way(self):
        self.assertEqual(wall.may_invite("@mallory:duo", A1), rules.ERR_INVITE)
        self.assertEqual(wall.may_invite(A1, "@mallory:duo"), rules.ERR_INVITE)
        self.assertEqual(wall.may_invite(A1, ADMIN), rules.ERR_INVITE)
        self.assertEqual(wall.may_invite("@mallory:duo", "@mallory:duo"), rules.ERR_INVITE)

    def test_the_service_account_is_exempt(self):
        self.assertIsNone(wall.may_invite(ADMIN, B1))


class Joins(unittest.TestCase):
    def test_same_org_members_and_the_service_account_are_fine(self):
        self.assertIsNone(wall.may_join(A1, {ADMIN: "join", A2: "join", A1_DUO: "invite"}))
        self.assertIsNone(wall.may_join(A1, {ADMIN: "join"}))
        self.assertIsNone(wall.may_join(A1, {}))

    def test_a_member_or_invitee_of_another_org_refuses(self):
        self.assertEqual(wall.may_join(A1, {ADMIN: "join", B1: "join"}), rules.ERR_JOIN)
        self.assertEqual(wall.may_join(A1, {B1_DUO: "invite"}), rules.ERR_JOIN)

    def test_left_or_banned_members_do_not_count(self):
        self.assertIsNone(wall.may_join(A1, {B1: "leave", B1_DUO: "ban"}))

    def test_an_org_less_member_refuses(self):
        self.assertEqual(wall.may_join(A1, {"@mallory:duo": "join"}), rules.ERR_JOIN)

    def test_an_org_less_joiner_is_refused_even_into_an_empty_room(self):
        self.assertEqual(wall.may_join("@mallory:duo", {}), rules.ERR_NO_ORG)
        self.assertEqual(wall.may_join("@orga1111.a.b:duo", {ADMIN: "join"}), rules.ERR_NO_ORG)

    def test_the_joiner_own_invite_is_not_a_conflict(self):
        self.assertIsNone(wall.may_join(A1, {A1: "invite", ADMIN: "join"}))

    def test_the_service_account_joins_anywhere(self):
        self.assertIsNone(wall.may_join(ADMIN, {A1: "join", B1: "join"}))

    def test_orgs_in_room_skips_the_service_account_and_the_gone(self):
        self.assertEqual(wall.orgs_in_room({ADMIN: "join", A1: "join", A2: "invite", B1: "leave"}), frozenset({"orga1111"}))
        self.assertEqual(wall.orgs_in_room({ADMIN: "join"}), frozenset())
        self.assertEqual(wall.orgs_in_room({"@mallory:duo": "join"}), frozenset({None}))


def state(rule, **extra):
    return {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": rule, **extra}}


ALLOW = lambda room: [{"type": "m.room_membership", "room_id": room}]  # noqa: E731


class CreateRoom(unittest.TestCase):
    def create(self, config, user=A1, restricted=None):
        return wall.may_create_room(user, config, restricted or {})

    def test_plain_and_dm_rooms_are_fine(self):
        self.assertIsNone(self.create({}))
        self.assertIsNone(self.create({"preset": "private_chat", "visibility": "private", "name": "x"}))
        self.assertIsNone(self.create({"preset": "trusted_private_chat", "is_direct": True, "invite": [A2]}))
        self.assertIsNone(self.create({"invite": [A2, A1_DUO]}))
        self.assertIsNone(self.create({"creation_content": {"type": "m.space"}, "preset": "private_chat"}))

    def test_public_in_every_spelling_is_refused(self):
        self.assertEqual(self.create({"visibility": "public"}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"preset": "public_chat"}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"preset": "something_new"}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"visibility": None}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"visibility": "Public"}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [state("public")]}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [state("knock")]}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [state("private")]}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [{"type": "m.room.join_rules", "content": {}}]}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [{"type": "m.room.join_rules"}]}), rules.ERR_PUBLIC)
        # A public entry hidden after harmless ones.
        self.assertEqual(self.create({"initial_state": [{"type": "m.room.name", "content": {"name": "n"}}, state("public")]}), rules.ERR_PUBLIC)

    def test_invite_join_rule_and_other_state_are_fine(self):
        self.assertIsNone(self.create({"initial_state": [state("invite"), {"type": "m.room.topic", "state_key": "", "content": {"topic": "t"}}]}))

    def test_room_upgrade_shape_is_fine(self):
        # handlers/room.py builds it as a list of {type, state_key, content} with a creation_content and no preset.
        self.assertIsNone(self.create({"creation_content": {"predecessor": {}}, "initial_state": [state("invite"), {"type": "m.room.name", "state_key": "", "content": {"name": "n"}}]}))

    def test_cross_org_and_third_party_invites_are_refused(self):
        self.assertEqual(self.create({"invite": [A2, B1]}), rules.ERR_INVITE)
        self.assertEqual(self.create({"invite": ["@mallory:duo"]}), rules.ERR_INVITE)
        self.assertEqual(self.create({"invite": [42]}), rules.ERR_INVITE)
        self.assertEqual(self.create({"invite": A2}), rules.ERR_CREATE)
        self.assertEqual(self.create({"invite_3pid": [{"medium": "email", "address": "a@b.c", "id_server": "i"}]}), rules.ERR_3PID)

    def test_malformed_config_is_refused(self):
        self.assertEqual(self.create({"initial_state": "public"}), rules.ERR_CREATE)
        self.assertEqual(self.create({"initial_state": ["x"]}), rules.ERR_CREATE)
        self.assertEqual(self.create({"initial_state": [None]}), rules.ERR_CREATE)
        self.assertEqual(self.create(None), rules.ERR_CREATE)
        self.assertEqual(self.create([]), rules.ERR_CREATE)

    def test_restricted_only_to_a_room_of_the_creators_org(self):
        good = {"!space:duo": frozenset({"orga1111"})}
        self.assertIsNone(self.create({"initial_state": [state("restricted", allow=ALLOW("!space:duo"))]}, restricted=good))
        for restricted in [
            {"!space:duo": frozenset({"orgb2222"})},
            {"!space:duo": frozenset({"orga1111", "orgb2222"})},
            {"!space:duo": frozenset()},  # empty, or only the service account
            {"!space:duo": frozenset({None})},
            {},  # unknown room
        ]:
            self.assertEqual(self.create({"initial_state": [state("restricted", allow=ALLOW("!space:duo"))]}, restricted=restricted), rules.ERR_PUBLIC, restricted)
        for allow in [None, [], ["x"], [{"type": "m.room_membership"}], ALLOW("!space:duo") + ALLOW("!space:duo"), ALLOW("!space:duo") + [{"type": "m.room_membership", "room_id": "!other:duo"}]]:
            self.assertEqual(self.create({"initial_state": [state("restricted", allow=allow)]}, restricted=good), rules.ERR_PUBLIC, allow)

    def test_restricted_rooms_needed_reads_them_for_a_prefetch(self):
        config = {"initial_state": [state("restricted", allow=ALLOW("!a:duo") + ALLOW("!b:duo")), state("invite"), "junk", None, {"content": 3}]}
        self.assertEqual(rules.restricted_rooms_needed(config), frozenset({"!a:duo", "!b:duo"}))
        self.assertEqual(rules.restricted_rooms_needed(None), frozenset())
        self.assertEqual(rules.restricted_rooms_needed({"initial_state": 3}), frozenset())

    def test_no_org_and_the_service_account(self):
        self.assertEqual(self.create({}, user="@mallory:duo"), rules.ERR_NO_ORG)
        self.assertEqual(self.create({}, user="@orga1111.a.b:duo"), rules.ERR_NO_ORG)
        self.assertIsNone(self.create({"visibility": "public"}, user=ADMIN))

    def test_tuples_and_frozen_mappings_read_like_lists_and_dicts(self):
        # Synapse hands event content to check_event_for_spam frozen: tuples, and mappings that are not dicts.
        from types import MappingProxyType

        content = MappingProxyType({"join_rule": "restricted", "allow": (MappingProxyType({"type": "m.room_membership", "room_id": "!space:duo"}),)})
        self.assertIsNone(wall.may_send_join_rules(A1, content, {"!space:duo": frozenset({"orga1111"})}))


class JoinRulesEvents(unittest.TestCase):
    def test_no_room_becomes_public_afterwards(self):
        self.assertIsNone(wall.may_send_join_rules(A1, {"join_rule": "invite"}, {}))
        for content in [{"join_rule": "public"}, {"join_rule": "knock"}, {"join_rule": "knock_restricted"}, {}, None, "public"]:
            self.assertEqual(wall.may_send_join_rules(A1, content, {}), rules.ERR_PUBLIC, content)
        self.assertEqual(wall.may_send_join_rules("@mallory:duo", {"join_rule": "invite"}, {}), rules.ERR_NO_ORG)
        self.assertIsNone(wall.may_send_join_rules(ADMIN, {"join_rule": "public"}, {}))


class PublishAnd3pid(unittest.TestCase):
    def test_always_refused_except_for_the_service_account(self):
        self.assertEqual(wall.may_publish(A1), rules.ERR_PUBLISH)
        self.assertEqual(wall.may_publish("@mallory:duo"), rules.ERR_PUBLISH)
        self.assertIsNone(wall.may_publish(ADMIN))
        self.assertEqual(wall.may_send_3pid_invite(A1), rules.ERR_3PID)
        self.assertIsNone(wall.may_send_3pid_invite(ADMIN))


class Directory(unittest.TestCase):
    def test_only_the_requesters_org_is_shown(self):
        self.assertFalse(wall.hide_from_directory(A2, A1))
        self.assertFalse(wall.hide_from_directory(A1_DUO, A1))
        self.assertTrue(wall.hide_from_directory(B1, A1))
        self.assertTrue(wall.hide_from_directory(B1_DUO, A1_DUO))

    def test_the_service_account_and_unparseable_ids_are_hidden(self):
        self.assertTrue(wall.hide_from_directory(ADMIN, A1))
        self.assertTrue(wall.hide_from_directory("@mallory:duo", A1))
        self.assertTrue(wall.hide_from_directory(None, A1))

    def test_an_org_less_requester_sees_nothing_and_the_service_account_sees_all(self):
        self.assertTrue(wall.hide_from_directory(A1, "@mallory:duo"))
        self.assertTrue(wall.hide_from_directory("@mallory:duo", "@mallory:duo"))
        self.assertTrue(wall.hide_from_directory(A1, None))
        self.assertFalse(wall.hide_from_directory(A1, ADMIN))
        self.assertFalse(wall.hide_from_directory(B1, ADMIN))


class Config(unittest.TestCase):
    def test_a_good_config(self):
        self.assertEqual(rules.parse_config({"server_name": "duo", "service_accounts": [ADMIN]}), ("duo", frozenset({ADMIN})))

    def test_a_bad_config_raises(self):
        for bad in [
            None,
            {},
            {"server_name": "duo"},
            {"server_name": "", "service_accounts": [ADMIN]},
            {"server_name": "duo", "service_accounts": []},
            {"server_name": "duo", "service_accounts": "@workspace-admin:duo"},
            {"server_name": "duo", "service_accounts": ["@workspace-admin:other"]},
            {"server_name": "duo", "service_accounts": ["workspace-admin"]},
            {"server_name": "duo", "service_accounts": [42]},
            {"server_name": "duo:8448", "service_accounts": ["@workspace-admin:duo:8448"]},
        ]:
            with self.assertRaises(ValueError, msg=repr(bad)):
                rules.parse_config(bad)


if __name__ == "__main__":
    unittest.main()
