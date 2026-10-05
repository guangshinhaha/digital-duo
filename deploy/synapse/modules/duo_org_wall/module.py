"""Synapse glue for the org wall: registers the callbacks in `rules.OrgWall`.

Loaded from homeserver.yaml as `duo_org_wall.module.DuoOrgWall` (render_config.py
writes the block). Every callback fails closed: an error inside the module is
logged by class name only (a traceback or message could carry user ids) and
answered as a refusal, and a directory hit that cannot be judged is hidden.

What this returns (docs/deploy/hosted-workspace.md §6.2 says "only NOT_SPAM or
Codes.FORBIDDEN, never a boolean"): NOT_SPAM to allow, and to refuse
`(Codes.FORBIDDEN, {"error": <sentence>})`, the `(Codes, dict)` form these
callbacks accept on v1.161.0 (checked in its source and against a running server), so the
person sees why. It is still
`Codes.FORBIDDEN`; a Synapse that stopped accepting the pair would treat it as an
invalid value and reject, which is the same refusal without the sentence. The one
boolean is `check_username_for_spam`, whose contract is a boolean (True = hide).

Not called by Synapse, by design (hosted-workspace.md §6.2): invites and joins by
a server admin, and room creation by a server admin. That is the service account,
and it is why no person account may ever be an admin.
"""
import logging
from collections.abc import Mapping
from typing import Optional

from synapse.module_api import NOT_SPAM, ModuleApi
from synapse.module_api.errors import Codes, ConfigError

from . import rules

logger = logging.getLogger(__name__)


class DuoOrgWall:
    def __init__(self, config: tuple[str, frozenset[str]], api: ModuleApi):
        self._api = api
        self._wall = rules.OrgWall(*config)
        api.register_spam_checker_callbacks(
            user_may_invite=self.user_may_invite,
            user_may_join_room=self.user_may_join_room,
            user_may_create_room=self.user_may_create_room,
            user_may_publish_room=self.user_may_publish_room,
            user_may_send_3pid_invite=self.user_may_send_3pid_invite,
            check_event_for_spam=self.check_event_for_spam,
            check_username_for_spam=self.check_username_for_spam,
        )
        logger.info("duo_org_wall loaded")

    @staticmethod
    def parse_config(config: dict) -> tuple[str, frozenset[str]]:
        try:
            return rules.parse_config(config)
        except ValueError as error:
            raise ConfigError(str(error))

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _verdict(callback: str, reason: Optional[str]):
        if reason is None:
            return NOT_SPAM
        # The callback and the sentence, never an id: enough to see the wall working.
        logger.info("duo_org_wall: %s refused: %s", callback, reason)
        return Codes.FORBIDDEN, {"error": reason}

    @staticmethod
    def _failed(callback: str, error: Exception):
        # The class name only: nothing that could carry an id or a room name.
        logger.error("duo_org_wall: %s failed closed (%s)", callback, type(error).__name__)
        return Codes.FORBIDDEN, {"error": "This request cannot be checked right now."}

    async def _members(self, room_id: str) -> dict[str, str]:
        """user id -> membership, from the local room state (a database read, no network).

        Read fresh on every call and not cached: a room's orgs change when the service account invites
        someone (its invites are not judged, so no callback would clear a cache), and a stale answer is a
        hole in the wall. The cost was measured (hosted-workspace.md §6.2): about 3 ms at 400 members.
        """
        state = await self._api.get_room_state(room_id, [("m.room.member", None)])
        return {
            key[1]: str(event.content.get("membership"))
            for key, event in state.items()
            if key[0] == "m.room.member"
        }

    async def _restricted_orgs(self, room_ids) -> dict[str, frozenset]:
        return {room_id: self._wall.orgs_in_room(await self._members(room_id)) for room_id in room_ids}

    # -- callbacks ----------------------------------------------------------

    async def user_may_invite(self, inviter: str, invitee: str, room_id: str):
        try:
            return self._verdict("user_may_invite", self._wall.may_invite(inviter, invitee))
        except Exception as error:
            return self._failed("user_may_invite", error)

    async def user_may_join_room(self, user: str, room_id: str, is_invited: bool):
        try:
            if self._wall.is_service(user):
                return NOT_SPAM
            return self._verdict("user_may_join_room", self._wall.may_join(user, await self._members(room_id)))
        except Exception as error:
            return self._failed("user_may_join_room", error)

    async def user_may_create_room(self, user_id: str, room_config: dict):
        try:
            if self._wall.is_service(user_id):
                return NOT_SPAM
            needed = rules.restricted_rooms_needed(room_config)
            return self._verdict(
                "user_may_create_room", self._wall.may_create_room(user_id, room_config, await self._restricted_orgs(needed))
            )
        except Exception as error:
            return self._failed("user_may_create_room", error)

    async def user_may_publish_room(self, user_id: str, room_id: str):
        try:
            return self._verdict("user_may_publish_room", self._wall.may_publish(user_id))
        except Exception as error:
            return self._failed("user_may_publish_room", error)

    async def user_may_send_3pid_invite(self, inviter: str, medium: str, address: str, room_id: str):
        try:
            return self._verdict("user_may_send_3pid_invite", self._wall.may_send_3pid_invite(inviter))
        except Exception as error:
            return self._failed("user_may_send_3pid_invite", error)

    async def _join_rules_verdict(self, callback: str, sender: str, content):
        if self._wall.is_service(sender):
            return NOT_SPAM
        needed = rules.allowed_room_ids(rules.as_mapping(content))
        return self._verdict(callback, self._wall.may_send_join_rules(sender, content, await self._restricted_orgs(needed)))

    async def _space_child_verdict(self, event):
        """An m.space.child state event (#274): listing a room in a Space, which is how it becomes findable in the org."""
        sender = event.sender
        if self._wall.is_service(sender):
            return NOT_SPAM
        child_id = event.get_state_key()
        if child_id is None:
            # Not a state event: a timeline event of this type links nothing.
            return NOT_SPAM
        existing = await self._api.get_room_state(event.room_id, [(rules.SPACE_CHILD_EVENT, child_id)])
        link = existing.get((rules.SPACE_CHILD_EVENT, child_id))
        child = await self._api.get_room_state(
            child_id, [(rules.JOIN_RULES_EVENT, ""), (rules.HISTORY_EVENT, ""), (rules.MEMBER_EVENT, None)]
        )
        join_rules = child.get((rules.JOIN_RULES_EVENT, ""))
        history = child.get((rules.HISTORY_EVENT, ""))
        members = {
            key[1]: str(state.content.get("membership")) for key, state in child.items() if key[0] == rules.MEMBER_EVENT
        }
        join_rules_content = join_rules.content if join_rules is not None else {}
        # No history-visibility event reads as `shared` (the spec's default, and Synapse's).
        history_content = history.content if history is not None else {"history_visibility": "shared"}
        needed = rules.allowed_room_ids(rules.as_mapping(join_rules_content))
        return self._verdict(
            "check_event_for_spam",
            self._wall.may_link_child(
                sender,
                event.room_id,
                event.content,
                (link.sender, link.content) if link is not None else None,
                join_rules_content,
                history_content,
                members,
                await self._restricted_orgs(needed),
            ),
        )

    async def check_event_for_spam(self, event):
        # Runs for every event a local client sends: answer at once unless it is
        # a join-rules, history-visibility or guest-access event (the state that can
        # open a room to people outside it), or an m.space.child event (listing a room
        # in a Space, which makes it findable there, #274). Room creation never comes through here,
        # which is why user_may_create_room reads initial_state. Not user_may_send_state_event:
        # experimental, and on v1.161.0 it drops the (Codes, dict) pair, so the person
        # would get Synapse's fixed sentence instead of ours.
        try:
            if event.type == rules.JOIN_RULES_EVENT:
                return await self._join_rules_verdict("check_event_for_spam", event.sender, event.content)
            if event.type in rules.READABILITY_EVENTS:
                return self._verdict("check_event_for_spam", self._wall.may_send_readability(event.sender, event.type, event.content))
            if event.type == rules.SPACE_CHILD_EVENT:
                return await self._space_child_verdict(event)
            return NOT_SPAM
        except Exception as error:
            return self._failed("check_event_for_spam", error)

    async def check_username_for_spam(self, user_profile: Mapping, requester_id: str) -> bool:
        # True hides the profile. Two parameters exactly: Synapse counts them
        # to decide whether to pass the requester.
        try:
            return self._wall.hide_from_directory(user_profile.get("user_id"), requester_id)
        except Exception as error:
            self._failed("check_username_for_spam", error)
            return True
