# Research notes

These documents record dated investigations, source snapshots, and hypotheses. They are not implementation specifications or a current feature backlog. The [README](../../README.md), implementation, and [ADRs](../adr/) describe accepted behavior; later ADR revisions take precedence over earlier research recommendations.

| Topic | Scope and subsequent decisions |
| --- | --- |
| [Personal agent memory](personal-agent-memory.md) | Early memory design; review scheduling was superseded by ADR-0012's 2026-11-02 revision |
| [Context compaction](context-compaction.md) | Historical implementation research; current context behavior follows the README and ADRs |
| [SnowLuma recovery](snowluma-recovery.md) | Sending and disconnection boundaries underlying ADR-0007 and ADR-0008 |
| [Social tool use](social-agent-tool-use-survey.md) | Historical comparison of resource access, tools, and skills; current plugins are documented separately |
| [Neuro-sama conversation style](neuro-sama-conversation-style.md) | Public evidence and hypothetical prompt experiments; examples are invented |
| [Agent TUI design references](agent-tui-design-references.md) | Design exploration; implementation status is stated in the document |

Keep source dates, pinned revisions, inference boundaries, and reproducible synthetic examples. Do not include private deployment settings, actual account or group identifiers, credentials, private conversations, or links to ignored personal files. Local experiments and generated previews belong outside tracked research, for example under ignored `output/`.
