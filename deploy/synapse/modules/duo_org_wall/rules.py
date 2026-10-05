"""The org wall's decisions, as pure functions of strings and dicts.

No Synapse import and no I/O: `module.py` reads the room state and turns a
verdict into a Synapse return value. A verdict is None (allowed) or a short,
fixed sentence for the person who was refused (it never names another org).

The org of an account is read from its Matrix id (docs/deploy/hosted-workspace.md
§4): `@<orgId>.<handle>:<server>` for a person, `@duo-<orgId>.<handle>:<server>`
for their duo. Only the service account may have no org. Anything else that does
not match exactly (a second dot, an uppercase letter, another server name) has no
org and is refused everything: it can only exist if something bypassed the
provisioner.
"""
import re
from collections.abc import Mapping
from typing import Iterable, Optional

# Lowercase letters and digits on each side of exactly one dot, `duo-` optional.
# The record's parse is looser (first dot wins); this is stricter on purpose so
# that a malformed id has no org rather than a surprising one. Both are used with
# fullmatch, never match plus `$`: `$` also matches before a trailing newline, so
# `@orga1111.zzz\n:duo` would otherwise read as org `orga1111`.
_LOCALPART = re.compile(r"(?:duo-)?([a-z0-9]+)\.([a-z0-9]+)")
_USER_ID = re.compile(r"@([^:@\s]+):([^:@\s]+)")
# A bare hostname (what src/hosted/matrix-accounts.ts assertServerName also accepts): no port,
# because `@x:host:8448` cannot be split into localpart and server by the parse above.
_SERVER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*")

# The only join rules a member-created room may have. `restricted` is allowed
# only when every allow entry points at a room holding just the creator's org
# (that is what "restricted to the org's Space" means).
ALLOWED_JOIN_RULES = ("invite", "restricted")
ALLOWED_PRESETS = (None, "private_chat", "trusted_private_chat")
# What a member may set history visibility to: never `world_readable`, which lets any account
# that has the room id (an alias is enough) read the room without being in it.
READABLE_HISTORY = ("invited", "joined", "shared")
# Guests: a member may not turn `can_join` on afterwards (guests are also off on the server). Not judged in
# createRoom's initial_state: Synapse's own `private_chat` preset writes `can_join`, and a room upgrade copies
# it (found by the real-Synapse upgrade check), so refusing it there would break every upgrade.
GUEST_ACCESS_ALLOWED = ("forbidden",)
JOIN_RULES_EVENT = "m.room.join_rules"
HISTORY_EVENT = "m.room.history_visibility"
GUEST_EVENT = "m.room.guest_access"
MEMBER_EVENT = "m.room.member"
SPACE_CHILD_EVENT = "m.space.child"
READABILITY_EVENTS = (HISTORY_EVENT, GUEST_EVENT)

ERR_INVITE = "Invites across organisations are not allowed."
ERR_JOIN = "This room has members from another organisation."
ERR_NO_ORG = "This account does not belong to an organisation."
ERR_PUBLIC = "Public rooms are not allowed on this server."
ERR_3PID = "Invites by email or phone number are not allowed."
ERR_PUBLISH = "Publishing rooms to the room directory is not allowed."
ERR_CREATE = "This room cannot be created."
ERR_LINK = "Only a room open to your own organisation, and that you are in, can be listed here."
ERR_UNLINK = "Only the person who listed a room here can change or remove that listing."


def parse_config(config: object) -> tuple[str, frozenset[str]]:
    """Validates the `modules:` config block. Raises ValueError on anything off."""
    if not isinstance(config, Mapping):
        raise ValueError("duo_org_wall: config must be a mapping")
    server_name = config.get("server_name")
    if not isinstance(server_name, str) or _SERVER_NAME.fullmatch(server_name) is None:
        raise ValueError(
            "duo_org_wall: config.server_name must be the homeserver's bare server_name, a hostname without a port "
            "(the org parse cannot read `@x:host:port`)"
        )
    accounts = config.get("service_accounts")
    if not isinstance(accounts, (list, tuple)) or not accounts:
        raise ValueError("duo_org_wall: config.service_accounts must be a non-empty list")
    for account in accounts:
        match = _USER_ID.fullmatch(account) if isinstance(account, str) else None
        if match is None or match.group(2) != server_name:
            raise ValueError("duo_org_wall: every service account must be @localpart:" + server_name)
    return server_name, frozenset(accounts)


def as_mapping(value: object) -> Mapping:
    return value if isinstance(value, Mapping) else {}


def restricted_rooms_needed(room_config: object) -> frozenset[str]:
    """Room ids a `restricted` join rule in this create config points at (for a prefetch)."""
    found = set()
    for entry in _sequence(as_mapping(room_config).get("initial_state")):
        found |= allowed_room_ids(as_mapping(as_mapping(entry).get("content")))
    return frozenset(found)


def _sequence(value: object) -> tuple:
    return tuple(value) if isinstance(value, (list, tuple)) else ()


def allowed_room_ids(content: Mapping) -> set[str]:
    return {
        entry["room_id"]
        for entry in _sequence(content.get("allow"))
        if isinstance(entry, Mapping) and isinstance(entry.get("room_id"), str)
    }


class OrgWall:
    def __init__(self, server_name: str, service_accounts: Iterable[str]):
        self.server_name = server_name
        self.service_accounts = frozenset(service_accounts)

    def is_service(self, user_id: object) -> bool:
        return isinstance(user_id, str) and user_id in self.service_accounts

    def org_of(self, user_id: object) -> Optional[str]:
        """The org in this account's id, or None (no org: refuse, unless it is the service account)."""
        if not isinstance(user_id, str):
            return None
        id_match = _USER_ID.fullmatch(user_id)
        if id_match is None or id_match.group(2) != self.server_name:
            return None
        local_match = _LOCALPART.fullmatch(id_match.group(1))
        return local_match.group(1) if local_match else None

    def _same_org(self, actor: str, other: object) -> bool:
        org = self.org_of(actor)
        return org is not None and org == self.org_of(other)

    def may_invite(self, inviter: str, invitee: str) -> Optional[str]:
        if self.is_service(inviter):
            return None
        return None if self._same_org(inviter, invitee) else ERR_INVITE

    def may_join(self, user_id: str, members: Mapping[str, str]) -> Optional[str]:
        """`members` is user id -> membership for the room's member events."""
        if self.is_service(user_id):
            return None
        org = self.org_of(user_id)
        if org is None:
            return ERR_NO_ORG
        for member, membership in members.items():
            if member == user_id or membership not in ("join", "invite"):
                continue
            if self.is_service(member):
                continue
            if self.org_of(member) != org:
                return ERR_JOIN
        return None

    def orgs_in_room(self, members: Mapping[str, str]) -> frozenset[Optional[str]]:
        """Orgs of the joined and invited members, the service account skipped (None = an org-less member)."""
        return frozenset(
            self.org_of(member)
            for member, membership in members.items()
            if membership in ("join", "invite") and not self.is_service(member)
        )

    def join_rule_problem(self, actor_org: str, content: Mapping, restricted_orgs: Mapping[str, frozenset]) -> Optional[str]:
        rule = content.get("join_rule")
        if rule == "invite":
            return None
        if rule != "restricted":
            return ERR_PUBLIC
        rooms = _sequence(content.get("allow"))
        wanted = allowed_room_ids(content)
        # Every allow entry must be a room membership entry for a room whose
        # members are all in the actor's org (and that has some).
        if not rooms or len(wanted) != len(rooms):
            return ERR_PUBLIC
        for room_id in wanted:
            if restricted_orgs.get(room_id) != frozenset({actor_org}):
                return ERR_PUBLIC
        return None

    @staticmethod
    def history_problem(content: Mapping) -> Optional[str]:
        """A history visibility that would let a non-member read the room (only `world_readable` does)."""
        return None if content.get("history_visibility") in READABLE_HISTORY else ERR_PUBLIC

    @staticmethod
    def guest_problem(content: Mapping) -> Optional[str]:
        return None if content.get("guest_access") in GUEST_ACCESS_ALLOWED else ERR_PUBLIC

    def may_create_room(self, user_id: str, room_config: object, restricted_orgs: Mapping[str, frozenset]) -> Optional[str]:
        if self.is_service(user_id):
            return None
        org = self.org_of(user_id)
        if org is None:
            return ERR_NO_ORG
        if not isinstance(room_config, Mapping):
            return ERR_CREATE
        config = room_config
        if config.get("visibility", "private") != "private":
            return ERR_PUBLIC
        if config.get("preset") not in ALLOWED_PRESETS:
            return ERR_PUBLIC
        if config.get("invite_3pid"):
            return ERR_3PID
        invites = config.get("invite", [])
        if not isinstance(invites, (list, tuple)):
            return ERR_CREATE
        for invitee in invites:
            if not self._same_org(user_id, invitee):
                return ERR_INVITE
        initial_state = config.get("initial_state", [])
        if not isinstance(initial_state, (list, tuple)):
            return ERR_CREATE
        for entry in initial_state:
            if not isinstance(entry, Mapping):
                return ERR_CREATE
            # Synapse writes initial_state events with no invite, join or spam callback, so this is the only
            # place to stop them. A fresh room needs no member entry (invites go in `invite`, checked above),
            # and one for another org's user would deliver that user an invite carrying the sender's text.
            if entry.get("type") == MEMBER_EVENT:
                return ERR_INVITE
            if entry.get("type") == JOIN_RULES_EVENT:
                problem = self.join_rule_problem(org, as_mapping(entry.get("content")), restricted_orgs)
            elif entry.get("type") == HISTORY_EVENT:
                problem = self.history_problem(as_mapping(entry.get("content")))
            else:
                problem = None
            if problem:
                return problem
        return None

    def may_send_join_rules(self, user_id: str, content: object, restricted_orgs: Mapping[str, frozenset]) -> Optional[str]:
        """A client-sent m.room.join_rules event: no room may be made public after creation."""
        if self.is_service(user_id):
            return None
        org = self.org_of(user_id)
        if org is None:
            return ERR_NO_ORG
        return self.join_rule_problem(org, as_mapping(content), restricted_orgs)

    def may_send_readability(self, user_id: str, event_type: object, content: object) -> Optional[str]:
        """A client-sent m.room.history_visibility or m.room.guest_access event: no room may be opened to non-members."""
        if self.is_service(user_id):
            return None
        if event_type not in READABILITY_EVENTS:
            return None
        if self.org_of(user_id) is None:
            return ERR_NO_ORG
        check = self.history_problem if event_type == HISTORY_EVENT else self.guest_problem
        return check(as_mapping(content))

    def may_link_child(
        self,
        user_id: str,
        parent_room_id: object,
        content: object,
        existing_link: Optional[tuple[object, object]],
        child_join_rules: object,
        child_history: object,
        child_members: Mapping[str, str],
        restricted_orgs: Mapping[str, frozenset],
    ) -> Optional[str]:
        """A client-sent m.space.child event (#274): how a room becomes findable within one org.

        A room is findable by colleagues when it is a child of the org's Space: Synapse's /hierarchy and
        room summary then show it, but only to someone who is in the room or in a room its `restricted`
        rule names (synapse/handlers/room_summary.py `_is_local_room_accessible`), and the org Space holds
        one org. So the link is allowed only for a room that is already open to exactly the sender's org
        through this very parent: join rule `restricted`, the parent among its allow entries, every allow
        entry a room of the sender's org (the same strict reading as rule 3), every joined or invited member
        in the sender's org, the sender joined, and history not world-readable. Joins into it are still each
        judged by `may_join`; this check is what keeps a listing honest, not the only wall.

        `existing_link` is (sender, content) of the parent's current m.space.child for this child, or None.
        A link nobody holds yet (none, or one already removed), or the sender's own, may be written; a live
        one written by anyone else (the service account's link to `#general`, a colleague's channel) may not
        be changed or removed by a member. A removal (no `via`, which is how Synapse reads a link as gone)
        of the sender's own link is always allowed.
        """
        if self.is_service(user_id):
            return None
        org = self.org_of(user_id)
        if org is None:
            return ERR_NO_ORG
        if existing_link is not None:
            link_sender, link_content = existing_link
            if as_mapping(link_content).get("via") and link_sender != user_id:
                return ERR_UNLINK
        if not as_mapping(content).get("via"):
            return None
        if not isinstance(parent_room_id, str):
            return ERR_LINK
        if child_members.get(user_id) != "join":
            return ERR_LINK
        if self.orgs_in_room(child_members) != frozenset({org}):
            return ERR_LINK
        join_rules = as_mapping(child_join_rules)
        if join_rules.get("join_rule") != "restricted" or parent_room_id not in allowed_room_ids(join_rules):
            return ERR_LINK
        if self.join_rule_problem(org, join_rules, restricted_orgs) is not None:
            return ERR_LINK
        if self.history_problem(as_mapping(child_history)) is not None:
            return ERR_LINK
        return None

    def may_publish(self, user_id: str) -> Optional[str]:
        return None if self.is_service(user_id) else ERR_PUBLISH

    def may_send_3pid_invite(self, user_id: str) -> Optional[str]:
        return None if self.is_service(user_id) else ERR_3PID

    def hide_from_directory(self, profile_user_id: object, requester_id: object) -> bool:
        """True to exclude `profile_user_id` from `requester_id`'s directory search."""
        if self.is_service(requester_id):
            return False
        if self.is_service(profile_user_id):
            return True
        requester_org = self.org_of(requester_id)
        return requester_org is None or requester_org != self.org_of(profile_user_id)
