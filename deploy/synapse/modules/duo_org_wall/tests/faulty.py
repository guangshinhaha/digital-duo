"""Deliberately broken modules for real_synapse.py: what Synapse does when a module errors.

FaultyWall is the real module with its reads and one decision broken, to prove
the module's own fail-closed paths against a running Synapse. RaisingModule is a
bare module whose callbacks raise straight out, to observe what Synapse itself
does with an uncaught exception (the decision record asked for this to be verified).
"""
from duo_org_wall.module import DuoOrgWall

# Never a real id or room name: the log check looks for it and must not find it.
MARKER = "SECRET-MARKER-DO-NOT-LOG"


class FaultyWall(DuoOrgWall):
    def __init__(self, config, api):
        super().__init__(config, api)

        def boom(*args, **kwargs):
            raise RuntimeError(MARKER)

        self._wall.hide_from_directory = boom

    async def _members(self, room_id):
        raise RuntimeError(MARKER)


class RaisingModule:
    def __init__(self, config, api):
        async def boom(*args, **kwargs):
            raise RuntimeError(MARKER)

        api.register_spam_checker_callbacks(
            user_may_invite=boom,
            user_may_join_room=boom,
            user_may_create_room=boom,
            check_username_for_spam=boom,
        )

    @staticmethod
    def parse_config(config):
        return config
