# Alibaba Cloud Agent Memory migration fit assessment

Reviewed: 2026-11-05. This document records checks against official documentation and design inferences, not an accepted architecture change. No cloud resources were created, paid services called, or project runtime data uploaded. Vendor capability descriptions are not treated as measured results for this project.

## Assessment

The user clarified that no specific Alibaba Cloud product had been selected; the question was whether it could implement the **memory graph** discussed earlier. For that goal, **Polar Agent Memory in PolarDB for AI is worth considering as a graph candidate; the Mem0-compatible PolarDB Agent Memory service is better suited to an initial managed-retrieval experiment. A wholesale replacement of the project's Memory is not recommended at present.** Capabilities and prices from these two paths must not be conflated. Keep the local memory model and authoritative SQLite records, compare associative recall on the same examples first, and initially treat cloud structures as a rebuildable auxiliary layer.

A managed service is worth considering if the goal is to reduce large-scale index operations. If the goal is better relationship understanding, persona continuity, or lower memory-review overhead, changing storage alone does not demonstrate a solution. Nor is there evidence that existing recall already outperforms cloud retrieval.

## Identify the product first

"Alibaba Cloud Agent Memory" does not identify a single product. In particular, distinguish the two PolarDB paths below rather than applying one path's interfaces, maturity, or pricing to the other.

| Product | Official positioning and status | Scope of this assessment |
| --- | --- | --- |
| Polar Agent Memory (PolarDB for AI) | Long-term memory engine combining vectors and knowledge graphs; limited rollout, requiring a GPU AI node | Primary candidate for graph capabilities |
| PolarDB Agent Memory (Mem0-compatible service) | Managed long-term memory; Standard Edition commercially available, Enterprise Edition still in limited rollout | Candidate for general managed retrieval |
| Milvus Agent Memory Service (AMS) | Long-term memory across sessions; officially still in invitation-only testing | Secondary candidate |
| AgentRun MemoryCollection | Combines long-term memory, session history, and session state, with OTS/RDS among the backends | Product distinction only |
| Bailian memory store | API management of factual memories and user profiles | Product distinction only |

Sources: [PolarDB for AI long-term memory](https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-agent-memory), [Creating PolarDB Agent Memory](https://help.aliyun.com/zh/polardb/polardb-for-mysql/create-polardb-agent-memory), [AMS introduction](https://help.aliyun.com/zh/milvus/user-guide/what-is-an-agent-memory-service), [AgentRun memory storage](https://help.aliyun.com/zh/agentrun/create-and-manage-memory-storage-1), [Bailian memory store](https://docs.agent.bailian.aliyun.com/zh/memory). The official release notes record the for AI engine in 2026-03 and the Mem0 service rename in 2026-09, further showing why names alone cannot justify combining them. [Release notes](https://help.aliyun.com/zh/polardb/polardb-for-mysql/release-notes/)

## Can it implement the memory graph discussed earlier?

The [earlier research](graph-memory-alternatives.md) distinguishes entity relationships, associations among memory notes, and temporal/causal links among events. This project's existing `sources` and `supersedes` represent evidence and revision relationships; they do not form a retrieval network for arbitrary relationships among people and events.

**The PolarDB for AI engine does describe graph capabilities beyond vector search.** Official documentation lists relationships among entities and among events. Retrieval responses include `event_memories` and `event_relations`, and memories carry source excerpts and times. It also explicitly describes revoking or rebuilding associated memories after deleting a source by `business_id`. The interface is `/polar-amem/...`, with isolation and queries currently based on `session_id` and input messages distinguished as `user/assistant`. Deployment remains in limited rollout and requires at least one GPU AI node. These are documented contracts, not behavior verified by running the service in this investigation. [Official features and API](https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-agent-memory)

These capabilities cover part of the associative recall we want and are closer to the provenance-management requirements than a metadata-only service. They still do not establish that the following project requirements are met:

| Graph goal | What remains to be validated for this project |
| --- | --- |
| Associations among people and events; multi-hop recall | Questions requiring several distinct events must find complete evidence by following associations, rather than returning only similar text. The public interface does not sufficiently specify controllable traversal depth, complete edge export, or manual edge correction |
| The same person continuing across groups | How `session_id` isolation fits a unified subject; multiple real people cannot all become an undifferentiated user. One session per group may fragment relationships, while putting everything in one session still requires preserving source contexts |
| Relationships changing over time | Distinguish write time, event time, and when a relationship becomes or ceases to be valid. Time-based retrieval or returned timestamps do not establish the ability to answer "What was the relationship at that time?" |
| Separating facts, reports, inferences, and fiction | Automatically extracted causal edges are model judgments, not facts by default. Speaker identity, evidence, and fictional flags must be retained |
| Complete propagation of deletion and revision | The engine declares propagation of source deletion. Multi-level dependencies, old versions, and in-flight background jobs still need testing, along with integration with local context and state cleanup |

**Costs also need a separate assessment.** Standard Edition pricing per 10,000 records in the next section does not apply to this GPU AI node deployment path. Pricing must reflect the cluster, AI nodes, models, and storage combination actually available for provisioning; this investigation did not obtain complete cost data for it.

The Mem0-compatible service's API documentation also mentions graph retrieval and prompts for extracting entities and graph relationships, so it cannot be described as having no graph capabilities at all. However, the public contract does not sufficiently explain control over graph nodes/edges, temporal validity, or evidence propagation to establish that it meets the same graph goals. [Mem0-compatible API](https://help.aliyun.com/zh/polardb/polardb-for-mysql/instructions-for-using-the-memory-management-api) The AMS material reviewed here mainly describes hybrid retrieval; a sufficiently specific graph-traversal contract was not found.

Start with six kinds of synthetic questions: merging aliases for one person across groups; following an acquaintance path through two introductions; querying addresses before and after a move; conflicts between first-person statements and others' reports; keeping fictional experiences out of evidence for real relationships; and ensuring that deleting the sole source removes related edges and that late jobs cannot rebuild them. Use existing retrieval as the baseline and compare the graph candidates from the earlier research on the same examples. Hindsight's current official documentation still explicitly provides graph traversal and temporal retrieval, making it a possible associative-recall comparison; this investigation did not reassess every candidate product. [Hindsight recall](https://hindsight.vectorize.io/developer/retrieval)

## PolarDB's Mem0-compatible service: confirmed capabilities

The official REST API can be called directly by the existing Node/TypeScript process without moving the entire Agent runtime for the sake of memory service integration. The service provides a private endpoint; a public endpoint requires an application and an access allowlist. Extraction strategies are customizable rather than limited to the default "user preferences" template. Source: [Using PolarDB Agent Memory](https://help.aliyun.com/zh/polardb/polardb-for-mysql/use-polardb-agent-memory).

The core API contract includes identifiers such as `agent_id/user_id/run_id` and `metadata`; `infer=false` to retain original text; hybrid semantic, BM25, and entity recall; updates/deletes by ID, batch operations, paginated listing, and change history. Asynchronous writes return a `job_id`. `message_id` can be used for merging and retries, while reverse lookup of memories by that ID remains in limited rollout. The documentation does not define `message_id` as a write idempotency key. Source: [Memory management API](https://help.aliyun.com/zh/polardb/polardb-for-mysql/instructions-for-using-the-memory-management-api).

The service also provides automatic merging, profiles/AI personality, time decay, expiry, reference counts, and visual export. These features may reduce the work of building a general memory service, but do not by themselves demonstrate compliance with this project's evidence, deletion, and persona-control requirements. Source: [Memory enhancement features](https://help.aliyun.com/zh/polardb/polardb-for-mysql/summary-of-memory-enhancement-features).

The published Standard Edition limits are 30 QPS and 20 million memories/vectors, using shared compute. Enterprise Edition attaches to the user's existing PolarDB MySQL cluster, whose resources must be considered separately. Region and edition cannot be changed directly after creation, and private-network communication requires matching regions/VPCs. Sources: [Creation instructions](https://help.aliyun.com/zh/polardb/polardb-for-mysql/create-polardb-agent-memory), [Product introduction](https://help.aliyun.com/zh/polardb/polardb-for-mysql/what-is-polardb-agent-memory).

## Judge cost against incremental benefit

On 2026-11-05, official Standard Edition pricing was CNY 0.015 per 10,000 records per hour in mainland China and CNY 0.0255 in Hong Kong, China, and overseas regions. Model tokens for extraction, embedding, and reranking are charged separately. Holding a constant 10,000 records over a 30-day, 720-hour month gives resource charges of approximately CNY 10.80 and CNY 18.36 per month, respectively. This is only arithmetic using published unit prices; it excludes models, other cloud resources, minimum billing increments, and specific billing rules. Estimating this project's actual monthly bill requires the volume of memories to synchronize, write frequency, retrieval volume, and model usage. Source: [Billing description](https://help.aliyun.com/zh/polardb/polardb-for-mysql/polardb-agent-memory-billing-description).

A low resource unit price does not imply a lower total cost. If the local system still handles the evidence graph, versions, deletion, and review while also calling cloud extraction, this adds another memory-processing pipeline. Demonstrate recall-quality or scale benefits before considering replacement of the existing implementation.

## AMS: different limitations from PolarDB

AMS defines `User` as the memory subject, which can be a person, Agent, or service account. It manages spaces through Workspace and represents sessions with `run_id`. It therefore does not require one Agent per chat user; a unified subject can be modeled in the adapter. Its current official status remains invitation-only testing. Source: [AMS introduction](https://help.aliyun.com/zh/milvus/user-guide/what-is-an-agent-memory-service).

Official examples cover Python, JavaScript `mem0ai`, and HTTP. An API key is bound to an Agent identity, and `app_id` can select a space. Sources: [AMS quick start](https://help.aliyun.com/zh/milvus/user-guide/fast-implementation-of-agent-memory-management), [AMS integration](https://help.aliyun.com/zh/milvus/user-guide/using-the-agent-memory-service).

AMS processes `add` in the background: consecutive messages for the same subject and session first enter a window, with topic changes or window thresholds able to trigger extraction. An `event_id` only indicates entry into the processing pipeline; it does not guarantee that a memory has been generated or is searchable in the index. This model suits extracting memories from conversation fragments, but cannot directly replace this project's contract of explicitly writing a memory and continuing to update it by version. Source: [AMS quick start](https://help.aliyun.com/zh/milvus/user-guide/fast-implementation-of-agent-memory-management).

The public AMS material reviewed here was insufficient to confirm contracts for fixed-content writes, complete provenance chains, deletion of derived content, restorable exports, and production billing/SLAs. These remain validation items, not claims that the service lacks support.

## Evidence required before a full migration

The following focuses on validation gaps for the Mem0-compatible service and AMS, rather than reporting vendor defects. The for AI graph engine already declares propagation of source deletion and should not be described as having only a verified single-record DELETE. It still needs testing against the full scope of project deletion requirements.

| Project requirement | What existing cloud capabilities do not yet establish | Validation |
| --- | --- | --- |
| Traceable provenance | Storing metadata or message IDs does not preserve arbitrary multi-level evidence dependencies by itself | Build a synthetic message → experience → understanding → revision chain and inspect every version and original source |
| No recall after source deletion | Single-record DELETE, whole-store reset, and expiry cleanup do not mean source-based revocation of all derived content | After deleting a source, check summaries, understanding, profiles, indexes, history, and unfinished background jobs; check again after recovery |
| Concurrent revisions | Semantic contradiction detection is not compare-and-swap; conditional updates and cross-record transactions are unconfirmed | Have two writers revise the same version; overwrites based on stale versions should be explicitly rejected |
| Unified subject and social context | Tenant isolation does not directly represent conversation, person, or sharing scope | Test identity and disclosure boundaries with the same person across groups, private chats, and multiple accounts |
| Fixed local memory content | `infer=false` is described as retaining original text and as a failure-compensation path; later retries/merges must be checked for unintended rewrites | Save explicit facts and unknown outcomes, trigger maintenance jobs, and compare content and IDs |
| Unknown outcomes after timeouts | Job lookup helps verification, but duplicate-request deduplication, crash recovery, and ordering guarantees are unconfirmed | Simulate a committed server write followed by a client timeout and check whether replay adds or overwrites records |
| Reversible migration | Listing/export does not establish restoration of complete semantics and dependencies | Export and rebuild in an empty environment, comparing sources, versions, scopes, and deletion state |
| Immediate visibility and failure semantics | Remote queries and index visibility cannot be assumed equivalent to synchronous local queries | Measure p50/p95, write-to-visibility delay, and recall and administrative deletion during network outages |

Constraint sources: [ADR-0001](../adr/0001-one-agent-across-group-environments.md), [ADR-0003](../adr/0003-separate-runtime-control-from-social-requests.md), [ADR-0006](../adr/0006-experience-understanding-and-continuing-state.md), [ADR-0008](../adr/0008-preserve-unknown-action-outcomes.md), [ADR-0009](../adr/0009-embedded-pi-with-local-state-and-cli.md), [ADR-0012](../adr/0012-self-maintained-development-alongside-the-operator-persona.md).

Two documentation inconsistencies also need clarification with the provider before deployment: the creation page says "plain text only", while newer feature/API documentation includes multimodal support; reference counts mean merge/update references on the API page and query hits on the feature page. Names alone should not be used to infer complete semantics or claim an equivalent implementation of this project's provenance dependency graph. Sources: [Creation instructions](https://help.aliyun.com/zh/polardb/polardb-for-mysql/create-polardb-agent-memory), [Memory management API](https://help.aliyun.com/zh/polardb/polardb-for-mysql/instructions-for-using-the-memory-management-api), [Memory enhancement features](https://help.aliyun.com/zh/polardb/polardb-for-mysql/summary-of-memory-enhancement-features).

## Fit with the project implementation

Code inspection used local HEAD `6c9a79b254456385c0f41addd160b55facb13ae3` and the workspace at that time. Existing workspace documentation changes were not treated as accepted new architecture.

| Current behavior and evidence | Migration implications and recommendations |
| --- | --- |
| The [Memory type](../../src/domain.ts#L16) retains kind, subjects, conversations, fictional, sources, supersedes, scope, and active | Metadata can carry these fields but does not automatically enforce their domain rules. Cloud retrieval results should resolve to complete records through local IDs |
| [writeMemory](../../src/store.ts#L295) checks that sources exist and remain valid, inherits contexts and fictional flags, and transactionally retires old versions and understanding that depends on them during revision | Retain local write decisions; remote ADD/UPDATE or automatic conflict resolution is not a direct equivalent |
| [Development evidence checks](../../src/store.ts#L387) recursively trace external evidence for habits and impressions; impressions of one person have a single current version | Automatically generated user profiles or AI personalities should be candidates first, without directly overwriting persona files, habits, or impressions |
| [forget](../../src/store.ts#L450) traces upstream to original sources and downstream to derived content, clears related state and context, and leaves tombstones against event replay; [table triggers](../../src/store.ts#L53) clean indexes | Remote deletion must cover corresponding copies, derived content, and in-flight jobs. A local recall ban prevents use but cannot be presented as completed physical deletion in the cloud |
| [runtimeContext](../../src/brain.ts#L336) supplies activities, commitments, and pursuits directly, and habits, practices, and impressions according to scope and people present | These must not become dependent on a top-k retrieval hit or on completion of cloud profile generation before restoration |
| [Spontaneous recall](../../src/recall.ts#L62) synchronously compares pregenerated vectors locally; [deliberate recall](../../src/recall.ts#L70) queries asynchronously and fuses lexical results, retaining lexical search when the model is unavailable | Experimenting with deliberate recall first makes boundaries easier to preserve. Remote spontaneous recall requires asynchronous prefetch, caching, and timeout fallbacks, not simply adding a request that waits for the cloud |
| [Pause control](../../src/runtime.ts#L177) stops both primary thinking and review; [administrative corrections](../../src/control.ts#L26) enter the local versioning and event flow | If cloud background consolidation becomes part of memory judgment, it must obey the same pause/generation controls or remain isolated as candidate work that does not affect authoritative memory. Editing/deleting authoritative memory directly in a cloud dashboard would bypass existing management logic |

These mechanisms have limits. Checking that sources exist and include external evidence does not verify that every natural-language judgment is supported by that evidence. Preserving social context does not mechanically guarantee that every cross-group retelling is appropriate. Both local and cloud systems need behavioral examples to evaluate these issues.

There are also real opportunities for improvement: [semantic candidates](../../src/recall.ts#L86) use a full in-memory scan; [line splitting](../../src/recall.ts#L13) allows at most 40 lines per record and 1,000 characters per line; [lexical search](../../src/store.ts#L404) has neither Chinese segmentation nor BM25 ranking. Cloud hybrid recall may be useful, but this investigation did not read the production database to measure current scale, identify bottlenecks, or compare Chinese recall. It cannot establish that migration is necessary.

ADR implications: auxiliary retrieval fits the replaceable-retrieval direction in [ADR-0009](../adr/0009-embedded-pi-with-local-state-and-cli.md); moving authoritative records away from SQLite requires reconsidering its local-storage choice. Making cloud extraction the direct source of memory judgments would require explicit revisions to the formation, evidence, and pause contracts in [ADR-0006](../adr/0006-experience-understanding-and-continuing-state.md) and [ADR-0012](../adr/0012-self-maintained-development-alongside-the-operator-persona.md). Generic "memory support" does not establish compliance. The latest ADR-0012 already permits an independent review context, so the question is not simply whether background processing exists.

## Proposed minimum validation path (not implemented)

If the goal is a graph, prioritize the six association scenarios above and confirm provisioning conditions, session modeling, and costs for the for AI engine. In that experiment, cloud-extracted relationships are only a candidate index; they cannot automatically replace local understanding, and returned content must map to known sources. The fixed-content synchronization path below mainly targets the Mem0-compatible service; its `infer=false` cannot be assumed to apply to the `/polar-amem` engine.

1. **Validate contracts before moving data.** Use synthetic records to verify that original-text writes are not automatically re-extracted, along with metadata filtering and return values, local-ID mapping, per-record deletion, expiry, job lookup, duplicate requests, and export. `message_id` has not been established as an idempotency key, so verify write outcomes before retrying. Without fixed content and stable mappings, do not use the service as a mirror index of existing memory.
2. **Prepare 50–100 examples with reference answers.** Distinguish missing records, incorrect understanding, retrieval omissions, recalled information left unused, and inappropriate social context. Start with synthetic and de-identified material; if real records are used later, separately determine what may be uploaded. Replay chronologically, allowing retrieval only from memories already present at each point, and keep candidate counts and context budgets equal.
3. **Compare retrieval without changing production judgments.** Write already-formed experiences, understanding, and notes as fixed content into a test namespace. Use the unified Agent as owner, retaining participants and conversations in metadata rather than splitting the subject by default into groups or chat users. Compare existing and cloud retrieval on relevance, omissions, false recall, person confusion, old-version leakage, p95 latency, index visibility delay, and total cost. Recalibrate cloud scores instead of copying current embedding thresholds.
4. **Integrate deliberate recall only after demonstrating benefits.** The current [Brain](../../src/brain.ts#L90), [tools](../../src/tools.ts#L29), and [CLI](../../src/cli.ts#L86) depend directly on the concrete `SemanticRecall` implementation; there is no complete backend interface switchable through configuration alone. Extract a narrow retrieval interface, retain mappings between local and remote IDs/versions, and implement a persistent synchronization queue. After receiving candidates, recheck the current local version, existence, kind, and query restrictions, and read the body locally. Historical search may separately allow old versions; explicitly deleted content must never return.
5. **Handle deletion and rollback before expanding scope.** Give deletion priority, use tombstones to prevent in-flight stale writes from republishing content, and make remote deletion status verifiable. Network outages, restarts, timeouts, and concurrent revisions must not incorrectly advance local state; failures should allow a return to existing retrieval. Define retention/cleanup scope for backups, exports, job payloads, and diagnostic copies. Cloud rebuilds should read only valid local data allowed for synchronization.

If fixed content plus metadata produces benefits, prefer retaining that boundary. Later adoption of automatic merging, profiling, or personality extraction should separately compare understanding quality, evidence quality, reversibility, and cost against existing review. These are another layer of behavioral migration; good retrieval-experiment results cannot substitute for their validation.

## Validation in this investigation

The existing relevant tests were run under Node `v24.22.1`:

```sh
node --import tsx --test --test-reporter=spec test/store.test.ts test/recall.test.ts test/development.test.ts test/memory-writing.test.ts
```

Result: **38/38 passed**. The tests use synthetic material and substitute models to validate existing storage, revision, deletion, recall, and development behavior. They do not establish a working Alibaba Cloud integration or benchmark Chinese embedding quality or real memory completeness. No runtime code, credentials, production database, or cloud resources were changed.
