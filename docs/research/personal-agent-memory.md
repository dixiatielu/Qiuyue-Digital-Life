# Lessons from personal agent memory for digital life

Reviewed: 2026-10-27. This is research into public sources, not an implementation specification; no memory benchmarks or deployments of these products were run. Current product documentation and historical papers are identified separately, and do not establish that every installed version has the same capabilities. Memory behavior confirmed in subsequent interviews is recorded in [ADR-0006](../adr/0006-experience-understanding-and-continuing-state.md); the storage and retrieval implementation had not yet been selected.

## Verified mechanisms

### OpenAI Dots: continuing its own notes across channels

Official Dots documentation distinguishes currently selected context, searchable past conversations, relevant ChatGPT memory, and notes continuously updated by the dot itself. The notes capture preferences, decisions, and ongoing work, not complete chat logs. ChatGPT, Slack, Teams, and other entry points belong to the same dot, and its notes can continue across them; the ability to use information does not imply permission to disclose it to another audience. The documentation also describes background research agents. It does not disclose the database, vector indexes, or a specific memory-consolidation algorithm, so it establishes product behavior but does not justify claiming to reproduce its internal architecture. [Dots tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

### OpenClaw: layered storage, saving before compaction, and updates with provenance

Current official documentation describes the **Memory Core default plugin** as separating a small curated core, experience records, future intentions, and reports for human review. Core content enters context when its provenance qualifies; detailed experiences are recalled on demand. Background consolidation merges duplicates, marks entries superseded by new information, and retains sources; recalled content is not extracted again as new evidence. Deep recall can use sub-agents. [Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)

Before context compaction, the current Agent is normally given an opportunity to save important content. This step can fail or be skipped, so it does not guarantee complete preservation. [Memory overview](https://docs.openclaw.ai/concepts/memory)

Scope: this architecture belongs to Memory Core; other plugins may use different storage and writing mechanisms. Its default provenance rules classify content from non-owner group members as `untrusted` and prevent it from being promoted to the curated core. That is an owner-oriented product choice and should not be directly adopted as this project's rule for whether group members' experiences can become long-term memories. [Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)

### MemGPT and current Letta documentation: limited context and operable external memory

The MemGPT paper separates current context from external storage, with the model using tools to decide what to search, save, and make visible. Historical messages remain retrievable after removal from context. This demonstrates a feasible design path, not a guarantee that an Agent never forgets. [MemGPT, 2024 revision, section 2](https://arxiv.org/html/2310.08560v2)

The current Letta Docs consulted describe the **MemFS product workflow**: root memory files enter the prompt each turn, and material in indexed directories is read on demand. Changes are tracked in Git, without a semantic or vector index by default. Dreaming uses background sub-agents to consolidate memory. This workflow should not be generalized to historical MemGPT or to every SDK version's defaults. [MemFS](https://docs.letta.com/concepts/memfs), [Memory & dreaming](https://docs.letta.com/configuration/memory)

### Generative Agents: forming impressions from experience and using them in plans

This 2023 study directly targets simulated life: it stores observations, retrieves them by relevance, recency, and importance, forms reflections with evidence pointers, and uses them to create or adjust plans. Reflection helps a subject develop understanding of itself and others from concrete experiences. The paper also reports retrieval omissions and embellishment of known information. Its evaluation was a time-limited sandbox simulation, not proof of reliability in long-term real group chats. [Generative Agents, sections 4, 6.5, and 7](https://arxiv.org/html/2304.03442v2)

## Lessons and subsequent decisions for this project

These mechanisms are useful references, but memory should center on the digital life's own experiences, relationships, and activities. The operator is also someone it knows; runtime management authority does not mean all memory is centered on the operator's needs. The separation of experience records, long-term understanding, and continuing state below was confirmed in later interviews; see the root [GLOSSARY.md](../../GLOSSARY.md) for formal definitions.

| Component | Role for the digital life | Boundary with other components |
| --- | --- | --- |
| Core persona | Keeps identity, core values, and important settings stable | Modification rights follow the agreed persona boundary |
| Continuing state | Preserves current work, unprocessed events, activity progress, and wake-up arrangements | Must be read directly on recovery, not depend on a chance semantic search hit |
| Experience records | Preserve what it perceived and did, and where and with whom it interacted | Recording another person's claim does not establish that it happened |
| Long-term understanding | Preserves relationships, preferences, lessons, and impressions formed from experience | Impressions are revisable judgments and cannot overwrite the experiences supporting them |
| Current context | Collects state and relevant memories needed for the current thought | Limited working material, not the entire life history |

The recommended approach is for the same Agent to consolidate memory in its own primary thinking process, with ordinary programs handling persistence, indexing, and retrieval. Directly copying the background cognitive sub-agents of Dots, Letta, or OpenClaw would affect the [existing decision on a single primary thinking process](../adr/0002-single-attention-with-continuous-perception.md). Consolidation while resting can be the digital life's own activity, without adding another subject with independent judgment.

The recommendation is to distinguish first-hand perception, others' statements, the Agent's own inferences, and fictional life narratives, while preserving time, people, social context, and evidence. Conflicts may lead to new judgments and mark old ones as revised; repeatedly retrieving an impression should not count as new independent evidence. Actual tool execution results should retain their factual status, preventing life narratives from contaminating action records. These are design recommendations based on this project's constraints, not guarantees shared by the products above.

These sources do not require an immediate choice of database, vector store, or graph. First establish what is worth remembering, how it is revised, and when recall is needed; then compare implementations.

## Decision boundaries after the research

Q13–Q17 confirmed separate experience records and long-term understanding, importance judgments and consolidation by the same Agent, preservation of revisions to understanding, combined spontaneous and deliberate recall, and the rule that fading does not expire unfinished commitments. ADR-0006 governs accepted behavior; these decisions do not turn the discussion above into claims about external products' internal implementations.

Subsequent Q22–Q23 also confirmed that processed raw events are retained for 90 days by default, important experiences and necessary sources are retained long term, and unprocessed events are not deleted due to that period. The management interface supports inspection, correction, and explicit deletion; deletion must also address related indexes, summaries, and dependent long-term understanding. Storage, retrieval, and acceptance criteria are selected separately.
