"""duo_org_wall: a Synapse module that makes the org wall a hard wall.

Nothing is imported here on purpose: `rules` (the decisions, pure Python) is
testable without Synapse, and Synapse loads `duo_org_wall.module.DuoOrgWall`.
See docs/deploy/hosted-workspace.md §4 and §6 and docs/deploy/railway.md.

Source: this module is loaded into an internet-reachable Synapse (AGPL-3.0), so
its source is meant to be public (docs/workspace-platform.md section 4). It holds
no secret: the service account list is deployment config, rendered at boot.
"""
