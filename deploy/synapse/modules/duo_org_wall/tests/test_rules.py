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
            # `$` matches before a trailing newline; the parse must not (fullmatch), or these read as org orga1111.
            "@orga1111.zzz\n:duo",
            "@orga1111.alice:duo\n",
            "@orga1111\n.alice:duo",
            "@orga1111.alice\n:duo",
            "@duo-orga1111.alice\n:duo",
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


def member(who, membership="invite"):
    return {"type": "m.room.member", "state_key": who, "content": {"membership": membership, "reason": "spam"}}


def history(value):
    return {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": value}}


def guests(value):
    return {"type": "m.room.guest_access", "state_key": "", "content": {"guest_access": value}}


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

    def test_a_member_entry_in_initial_state_is_refused(self):
        # Synapse writes initial_state events with no invite check, so an invite for another org's user would be delivered.
        for entry in [
            member(B1),
            member(B1_DUO),
            member(A2),  # a fresh room needs none, even a same-org one: refuse them all
            member(A1, "join"),
            member(B1, "join"),
            member(B1, "leave"),
            {"type": "m.room.member", "content": {"membership": "invite"}},
            {"type": "m.room.member"},
        ]:
            self.assertEqual(self.create({"initial_state": [entry]}), rules.ERR_INVITE, entry)
            self.assertEqual(self.create({"initial_state": [state("invite"), {"type": "m.room.name", "content": {"name": "n"}}, entry]}), rules.ERR_INVITE, entry)
        self.assertIsNone(self.create({"initial_state": [member(B1)]}, user=ADMIN))

    def test_history_visibility_may_not_make_the_room_readable_by_others(self):
        for value in ("invited", "joined", "shared"):
            self.assertIsNone(self.create({"initial_state": [history(value)]}), value)
        for value in ("world_readable", "WORLD_READABLE", "bogus", "", None, 3, ["shared"]):
            self.assertEqual(self.create({"initial_state": [history(value)]}), rules.ERR_PUBLIC, value)
        self.assertEqual(self.create({"initial_state": [{"type": "m.room.history_visibility", "content": {}}]}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [{"type": "m.room.history_visibility"}]}), rules.ERR_PUBLIC)
        self.assertEqual(self.create({"initial_state": [history("shared"), history("world_readable")]}), rules.ERR_PUBLIC)

    def test_guest_access_in_initial_state_is_not_judged(self):
        # Synapse's private_chat preset writes can_join itself and a room upgrade copies it; refusing it here breaks upgrades.
        for value in ("forbidden", "can_join"):
            self.assertIsNone(self.create({"initial_state": [guests(value)]}), value)

    def test_the_service_account_may_still_set_any_of_it(self):
        self.assertIsNone(self.create({"initial_state": [history("world_readable"), member(B1)]}, user=ADMIN))

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


class ReadabilityEvents(unittest.TestCase):
    def test_no_room_becomes_readable_by_others_afterwards(self):
        for value in ("invited", "joined", "shared"):
            self.assertIsNone(wall.may_send_readability(A1, rules.HISTORY_EVENT, {"history_visibility": value}), value)
        for content in [{"history_visibility": "world_readable"}, {"history_visibility": "x"}, {}, None, "world_readable"]:
            self.assertEqual(wall.may_send_readability(A1, rules.HISTORY_EVENT, content), rules.ERR_PUBLIC, content)
        self.assertIsNone(wall.may_send_readability(A1, rules.GUEST_EVENT, {"guest_access": "forbidden"}))
        for content in [{"guest_access": "can_join"}, {}, None]:
            self.assertEqual(wall.may_send_readability(A1, rules.GUEST_EVENT, content), rules.ERR_PUBLIC, content)

    def test_org_less_senders_are_refused_and_the_service_account_is_exempt(self):
        self.assertEqual(wall.may_send_readability("@mallory:duo", rules.HISTORY_EVENT, {"history_visibility": "shared"}), rules.ERR_NO_ORG)
        self.assertIsNone(wall.may_send_readability(ADMIN, rules.HISTORY_EVENT, {"history_visibility": "world_readable"}))

    def test_other_event_types_are_not_judged_here(self):
        self.assertIsNone(wall.may_send_readability(A1, "m.room.message", {"body": "x"}))


SPACE_A, SPACE_B = "!spacea:duo", "!spaceb:duo"
LINK = {"via": ["duo"], "suggested": False}
OPEN_TO_A = {"join_rule": "restricted", "allow": ALLOW(SPACE_A)}
ROOMS_OF = {SPACE_A: frozenset({"orga1111"}), SPACE_B: frozenset({"orgb2222"})}


class SpaceChildLinks(unittest.TestCase):
    """#274: a room is findable within one org by being a child of the org's Space, and only then."""

    def link(self, sender=A1, parent=SPACE_A, content=LINK, existing=None, rules_content=OPEN_TO_A, history_content=None, members=None, restricted=None):
        return wall.may_link_child(
            sender,
            parent,
            content,
            existing,
            rules_content,
            {"history_visibility": "shared"} if history_content is None else history_content,
            {A1: "join", A2: "join"} if members is None else members,
            ROOMS_OF if restricted is None else restricted,
        )

    def test_a_member_lists_a_room_open_to_their_own_org_in_its_space(self):
        self.assertIsNone(self.link())
        self.assertIsNone(self.link(members={A1: "join"}))
        self.assertIsNone(self.link(members={A1: "join", A1_DUO: "invite", ADMIN: "join", B1: "leave"}))
        self.assertIsNone(self.link(sender=A1_DUO, members={A1_DUO: "join"}))
        for value in ("invited", "joined", "shared"):
            self.assertIsNone(self.link(history_content={"history_visibility": value}), value)

    def test_a_room_with_another_orgs_member_is_never_listed(self):
        self.assertEqual(self.link(members={A1: "join", B1: "join"}), rules.ERR_LINK)
        self.assertEqual(self.link(members={A1: "join", B1_DUO: "invite"}), rules.ERR_LINK)
        self.assertEqual(self.link(members={A1: "join", "@mallory:duo": "join"}), rules.ERR_LINK)

    def test_only_a_room_restricted_to_this_parent_and_only_rooms_of_the_senders_org(self):
        # A room created before #274 is invite-only (Synapse's private_chat preset): unaffected, and unlistable until changed.
        self.assertEqual(self.link(rules_content={"join_rule": "invite"}), rules.ERR_LINK)
        for content in [
            {},
            {"join_rule": "public"},
            {"join_rule": "knock"},
            {"join_rule": "knock_restricted", "allow": ALLOW(SPACE_A)},
            {"join_rule": "restricted"},
            {"join_rule": "restricted", "allow": []},
            {"join_rule": "restricted", "allow": ALLOW(SPACE_B)},  # another org's Space
            {"join_rule": "restricted", "allow": ALLOW("!elsewhere:duo")},  # not this parent
            {"join_rule": "restricted", "allow": ALLOW(SPACE_A) + ALLOW(SPACE_B)},  # this parent and another org's
            {"join_rule": "restricted", "allow": ALLOW(SPACE_A) + [{"type": "m.room_membership"}]},
            None,
            "restricted",
        ]:
            self.assertEqual(self.link(rules_content=content), rules.ERR_LINK, content)
        # The parent itself must hold only the sender's org (an org B Space cannot be the target of an org A link).
        self.assertEqual(self.link(parent=SPACE_B, rules_content={"join_rule": "restricted", "allow": ALLOW(SPACE_B)}), rules.ERR_LINK)
        self.assertEqual(self.link(restricted={SPACE_A: frozenset({"orga1111", "orgb2222"})}), rules.ERR_LINK)
        self.assertEqual(self.link(restricted={SPACE_A: frozenset()}), rules.ERR_LINK)
        self.assertEqual(self.link(restricted={}), rules.ERR_LINK)
        self.assertEqual(self.link(parent=None), rules.ERR_LINK)

    def test_the_sender_must_be_joined_to_the_room_they_list(self):
        self.assertEqual(self.link(members={A2: "join"}), rules.ERR_LINK)
        self.assertEqual(self.link(members={A1: "invite", A2: "join"}), rules.ERR_LINK)
        self.assertEqual(self.link(members={A1: "leave", A2: "join"}), rules.ERR_LINK)
        self.assertEqual(self.link(members={}), rules.ERR_LINK)  # also how an unknown room id reads

    def test_a_world_readable_room_is_never_listed(self):
        for content in [{"history_visibility": "world_readable"}, {}, {"history_visibility": None}]:
            self.assertEqual(self.link(history_content=content), rules.ERR_LINK, content)

    def test_any_truthy_via_is_judged_as_a_link(self):
        # Synapse reads only a list of strings as a live link, but a stranger shape is judged, never waved through.
        for via in (["duo"], "duo", {"x": 1}, [3]):
            self.assertEqual(self.link(content={"via": via}, rules_content={"join_rule": "invite"}), rules.ERR_LINK, via)

    def test_removing_your_own_link_or_writing_a_removed_one_needs_nothing_else(self):
        for content in ({}, {"via": []}, {"via": None}, None):
            self.assertIsNone(self.link(content=content, rules_content={"join_rule": "invite"}, members={}), content)
            self.assertIsNone(self.link(content=content, existing=(A1, LINK), rules_content={"join_rule": "invite"}, members={}), content)

    def test_someone_elses_live_link_cannot_be_changed_or_removed(self):
        for existing in [(ADMIN, LINK), (A2, LINK)]:  # the service account's #general link; a colleague's channel
            self.assertEqual(self.link(existing=existing), rules.ERR_UNLINK, existing)
            self.assertEqual(self.link(content={}, existing=existing), rules.ERR_UNLINK, existing)
        self.assertIsNone(self.link(existing=(A1, LINK)))
        # A link already removed (no via) is nobody's: it may be listed again.
        self.assertIsNone(self.link(existing=(A2, {})))
        self.assertIsNone(self.link(existing=(ADMIN, {"via": []})))

    def test_no_org_and_the_service_account(self):
        self.assertEqual(self.link(sender="@mallory:duo", members={"@mallory:duo": "join"}), rules.ERR_NO_ORG)
        self.assertEqual(self.link(sender="@mallory:duo", content={}), rules.ERR_NO_ORG)
        self.assertIsNone(self.link(sender=ADMIN, rules_content={"join_rule": "invite"}, members={B1: "join"}, existing=(A2, LINK)))


class OrgScopedChannels(unittest.TestCase):
    """#274 end to end, in the wall's own terms: what a findable-in-the-org room is, and what it is not."""

    def test_a_channel_open_to_the_org_space_is_creatable_listable_and_joinable_by_a_colleague(self):
        create = {"preset": "private_chat", "name": "channel", "initial_state": [state("restricted", allow=ALLOW(SPACE_A))]}
        self.assertIsNone(wall.may_create_room(A1, create, ROOMS_OF))
        self.assertIsNone(wall.may_link_child(A1, SPACE_A, LINK, None, OPEN_TO_A, {"history_visibility": "shared"}, {A1: "join"}, ROOMS_OF))
        # A colleague joins it with no invite: Synapse's restricted rule lets in members of the Space, and the wall agrees.
        self.assertIsNone(wall.may_join(A2, {A1: "join"}))
        self.assertIsNone(wall.may_join(A1_DUO, {A1: "join", A2: "join"}))

    def test_another_org_can_neither_join_it_nor_point_its_own_room_at_it(self):
        self.assertEqual(wall.may_join(B1, {A1: "join", A2: "join"}), rules.ERR_JOIN)
        self.assertEqual(wall.may_join(B1_DUO, {A1: "join"}), rules.ERR_JOIN)
        # Nor open its own room to org A's Space, nor list org A's room in its own Space.
        self.assertEqual(wall.may_create_room(B1, {"initial_state": [state("restricted", allow=ALLOW(SPACE_A))]}, ROOMS_OF), rules.ERR_PUBLIC)
        self.assertEqual(wall.may_link_child(B1, SPACE_B, LINK, None, OPEN_TO_A, {"history_visibility": "shared"}, {A1: "join", B1: "join"}, ROOMS_OF), rules.ERR_LINK)

    def test_public_and_directory_publishing_stay_refused(self):
        # The room directory (/publicRooms) is one list for the whole server, with no per-requester module filter in
        # Synapse 1.161.0: org scoping is the Space, never publishing.
        self.assertEqual(wall.may_create_room(A1, {"preset": "public_chat"}, ROOMS_OF), rules.ERR_PUBLIC)
        self.assertEqual(wall.may_create_room(A1, {"visibility": "public", "initial_state": [state("restricted", allow=ALLOW(SPACE_A))]}, ROOMS_OF), rules.ERR_PUBLIC)
        self.assertEqual(wall.may_publish(A1), rules.ERR_PUBLISH)

    def test_a_room_made_before_this_change_is_unaffected_until_explicitly_changed(self):
        # Invite-only, as #214's private groups are: still fine to use, not listable as it is.
        members = {A1: "join", A2: "join"}
        invite_only = {"join_rule": "invite"}
        self.assertEqual(wall.may_link_child(A1, SPACE_A, LINK, None, invite_only, {"history_visibility": "shared"}, members, ROOMS_OF), rules.ERR_LINK)
        # The explicit change: open it to the org's Space (rule 5 already allows this), then list it.
        self.assertIsNone(wall.may_send_join_rules(A1, OPEN_TO_A, ROOMS_OF))
        self.assertIsNone(wall.may_link_child(A1, SPACE_A, LINK, None, OPEN_TO_A, {"history_visibility": "shared"}, members, ROOMS_OF))
        # Private groups and DMs keep working exactly as before.
        self.assertIsNone(wall.may_create_room(A1, {"preset": "private_chat", "name": "group"}, {}))
        self.assertIsNone(wall.may_create_room(A1, {"preset": "trusted_private_chat", "is_direct": True, "invite": [A2]}, {}))
        self.assertEqual(wall.may_create_room(A1, {"is_direct": True, "invite": [B1]}, {}), rules.ERR_INVITE)


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
            {"server_name": "duo\n", "service_accounts": ["@workspace-admin:duo\n"]},
            {"server_name": "duo", "service_accounts": ["@workspace-admin:duo\n"]},
            {"server_name": "duo", "service_accounts": ["@workspace-admin\n:duo"]},
            {"server_name": "du o", "service_accounts": ["@workspace-admin:du o"]},
            {"server_name": "@duo", "service_accounts": ["@workspace-admin:@duo"]},
        ]:
            with self.assertRaises(ValueError, msg=repr(bad)):
                rules.parse_config(bad)

    def test_a_server_name_with_a_port_is_refused_with_a_clear_reason(self):
        # `@x:host:8448` cannot be split into localpart and server by this parse; src/hosted/matrix-accounts.ts
        # (assertServerName) refuses a port for the same reason, so the two agree.
        with self.assertRaises(ValueError) as caught:
            rules.parse_config({"server_name": "duo:8448", "service_accounts": ["@workspace-admin:duo:8448"]})
        self.assertIn("port", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
