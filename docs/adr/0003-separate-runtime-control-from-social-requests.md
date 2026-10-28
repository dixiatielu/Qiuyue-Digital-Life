# Separate runtime management from social requests

The operator must be able to pause the digital life, adjust configuration, and repair state, while the digital life must handle group members' requests and commitments autonomously. Runtime management therefore uses an explicit administrative interface. Ordinary statements in a group are social requests by default, including the operator's own ordinary statements, and the digital life decides how to handle them. This boundary gives pause and maintenance definite control while preserving consistent meanings for relationships, commitments, and refusals in the group.

The operator configures and controls changes to the core identity, background, and values; the digital life may express a wish to change them. Relationships, preferences, and habits may change autonomously through experience.

Runtime management here means this project's local operational control. The operator configures whether to expose SnowLuma's QQ profile, group management, and service management APIs as described in [ADR-0010](0010-expose-native-snowluma-actions.md); changing a QQ avatar, nickname, or signature does not change the core persona.

The operator uses the management interface to inspect, correct, and delete specific memories and their sources. Explicit deletion must also address related indexes, summaries, and long-term understanding dependent on that content, so that old content is not recalled again. Agent pause stops thinking, automatic wake-ups, and new external actions while continuing to receive and save environment events; after resumption, the Agent reassesses the backlog.
