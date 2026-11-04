# Whether to migrate to MemFS, Mem0, or Zep / Graphiti

Reviewed: 2026-11-02. This investigation reviewed this repository's design and implementation alongside official external documentation and source code. None of these products was deployed, no comparative retrieval benchmark was run, and no production data was migrated. External capabilities describe the versions examined at that time; vendor benchmarks are not evidence of performance in Qiuyue's actual group chats. This is a historical research snapshot, not a current migration plan.

## Assessment

**The recommendation at the review date was to avoid a wholesale migration. Keep this project's domain memory model and SQLite as the authoritative record, address measurable retrieval problems first, and introduce an external retrieval engine as a rebuildable auxiliary index when a clear gap warrants it.** This does not establish that the existing implementation performs better. There is no comparative evidence yet that replacement would address actual failures, while replacement would require rebuilding provenance, revision, social scope, and deletion propagation semantics.

Maturity has several distinct meanings: the maturity of storage and retrieval components, the fit of memory extraction behavior, and the maturity of an entire Agent platform. These are different migrations and cannot substitute for one another.

## Scope

This document compares the fit of **Letta MemFS**, Mem0, Graphiti, and Zep for this project's memory model. MemFS refers to Letta's file-based memory workflow.

## Behavior this project must preserve

These are migration acceptance criteria, not capabilities exclusive to a particular database:

- One Agent retains a unified identity, relationships, and long-term memory across groups while preserving the original social scope. [ADR-0001](../adr/0001-one-agent-across-group-environments.md)
- Experience records, long-term understanding, and continuing state remain separate. Commitments, activities, and other continuing state are restored directly rather than depending on a retrieval hit. Long-term understanding retains provenance and revision history; repeated recall is not new evidence. [ADR-0006](../adr/0006-experience-understanding-and-continuing-state.md)
- Actual experiences, others' statements, the Agent's own inferences, and fictional daily life must remain distinct. [ADR-0005](../adr/0005-configurable-life-with-experience-provenance.md)
- The same digital life reviews memory in a separate working context, in parallel with primary thinking, but cannot participate in conversations or send messages from that review. The earlier research claim that consolidation must occur in the primary context no longer applies. [ADR-0012, revision of 2026-11-02](../adr/0012-self-maintained-development-alongside-the-operator-persona.md)
- The retrieval implementation is replaceable; the stack at the review date was TypeScript, Pi Agent Core, and SQLite. [ADR-0009](../adr/0009-embedded-pi-with-local-state-and-cli.md)

### Implementation and limitations at the review date

The reviewed workspace implemented the following:

- `writeMemory` checks that sources exist and remain valid, inherits group context and fictional status from them, and recursively checks habits and impressions for external evidence. `supersedes` preserves version history and removes old versions and understandings dependent on them from everyday use. Checking that a source exists does not verify its truth; distinguishing statements from inferences still depends on the Agent's judgment. [Store implementation](../../src/store.ts#L275)
- Spontaneous recall compares message vectors with memory-line vectors and filters by a threshold and count limit. Messages are embedded asynchronously on arrival so waiting for the endpoint does not block thinking. Deliberate `recall` combines lexical and semantic results using RRF and retains lexical results when embedding fails. [Recall implementation](../../src/recall.ts#L116)
- Habits, practices, and impressions are supplied directly according to scope and the people present. Commitments, current activities, and continuing pursuits are also supplied directly rather than relying on a chance retrieval hit. Once memory enters the working context, incremental updates avoid repeated injection. [Runtime memory](../../src/brain.ts#L342), [ADR-0017](../adr/0017-tell-the-working-context-each-thing-once.md)
- Explicit forgetting follows source and derivation relationships to clear records, associated state, and working contexts. Memory deletion also clears vector and full-text indexes. Ordinary retention cleanup preserves pending events and evidence that is still referenced. [Forgetting](../../src/store.ts#L457), [Retention](../../src/store.ts#L493)

These mechanisms do not establish that memory quality in real group chats is satisfactory. The confirmed limitations and questions to measure were:

- Lexical queries split on runs of letters and numbers, so continuous Chinese text often becomes one long query term. FTS5 uses trigrams and does not rank lexical candidates with `bm25()`. Two-character terms can still match through the `instr()` substring branch; saying that two-character Chinese cannot be retrieved would be inaccurate. Real queries are needed to compare improvements in Chinese segmentation, exact entities, and ranking. [Lexical search](../../src/store.ts#L392)
- Semantic retrieval scans vectors in memory. Memories are indexed by line, with at most 40 eligible lines and 1,000 characters per line. Content beyond those limits may not enter the semantic index. Whether to replace the full scan should depend on measurements of actual scale, latency, and memory use. [Chunking](../../src/recall.ts#L31), [Vector comparison](../../src/recall.ts#L152)
- Ordinary long-term memories have creation times, sources, and replacement chains, but no structured fact-validity interval independent of write time. Natural language can describe past changes; Graphiti's temporal model may add clear value when complex relationships must be queried at a specific point in time. [Memory type](../../src/domain.ts#L19)
- Spontaneous recall returns nothing when a message has not yet been embedded or the endpoint is unavailable; it does not fall back to group matching. Habits and impressions are still supplied directly. This is a latency/relevance tradeoff whose missed-recall cost needs to be recorded. [Spontaneous recall](../../src/recall.ts#L116), [ADR-0009](../adr/0009-embedded-pi-with-local-state-and-cli.md)

The research record of 2026-11-02 reports running `node --import tsx --test --test-reporter=spec test/store.test.ts test/recall.test.ts test/development.test.ts`, with 37/37 tests passing at that time. This is a historical result, not a claim about the current test count or status. Those tests cover protocol behavior; they do not establish memory completeness, correctness of understanding, or appropriate recall timing. Retrieval tests use synthetic vectors, so they are neither an evaluation of Chinese embedding quality nor a comparison with external products.

The original Chinese test data is represented here with JavaScript Unicode escapes. A separate experiment wrote the long-term understanding `\u5c0f\u660e\u8bf4\u6700\u8fd1\u559c\u6b22\u4e4c\u9f99\u8336` ("Xiaoming says he has recently liked oolong tea") to an in-memory database, with subject identifiers `['7', '\u5c0f\u660e']` (numeric ID and the name Xiaoming). `Store.search('\u559c\u6b22')` ("like") and `Store.search('\u5c0f\u660e \u4e4c\u9f99\u8336')` ("Xiaoming oolong tea") each returned one result; `Store.search('\u5c0f\u660e\u6700\u8fd1\u559c\u6b22\u4ec0\u4e48\u8336')` ("What tea has Xiaoming liked recently?") returned none. This verifies that short Chinese substring matching still works and that full-sentence lexical queries have a segmentation gap. The semantic branch may fill that gap, so this alone does not establish a failure of the complete retrieval path. The experiment neither read nor modified a production database.

The synthetic example can be reproduced from the repository root. All people, messages, and identifiers below are test data, and only an in-memory database is used. Chinese test strings use JavaScript Unicode escapes, which preserve the original characters at runtime because their segmentation is the behavior under test.

```sh
node --import tsx --input-type=module <<'JS'
import { Store } from './src/store.ts';
const store = new Store(':memory:');
try {
  const text = '\u5c0f\u660e\u8bf4\u6700\u8fd1\u559c\u6b22\u4e4c\u9f99\u8336';
  const source = store.receive({
    key: 'synthetic:tea', kind: 'message', at: 1, actorId: 7, groupId: 100,
    text, payload: { message: [{ type: 'text', data: { text } }] },
  });
  store.writeMemory({ kind: 'understanding', title: 'Tea preference', content: text,
    importance: 5, subjects: ['7', '\u5c0f\u660e'], sources: [source.id] }, false);
  for (const query of ['\u559c\u6b22', '\u5c0f\u660e \u4e4c\u9f99\u8336', '\u5c0f\u660e\u6700\u8fd1\u559c\u6b22\u4ec0\u4e48\u8336']) {
    console.log(query, store.search(query).length);
  }
} finally { store.close(); }
JS
```

## External options

| Option | Capabilities available to adopt or purchase | Integration and operation | Fit for this project |
| --- | --- | --- | --- |
| Letta MemFS | Agent-readable and writable Markdown memories, Git history and synchronization, hierarchical context loading | The reviewed Letta runtime uses Node/TypeScript, with local execution, an App Server, and an Agent SDK | A complete workflow for readable, editable memory files; default retrieval is not automatically better than existing semantic recall |
| Mem0 OSS | Automatic memory extraction, vector retrieval, entity-assisted ranking, metadata filtering, CRUD, and history | A `mem0ai/oss` Node SDK; requires a persistent vector store, LLM, and embeddings; can also run as a service | Suitable for an independent memory-layer experiment; cannot directly take over this project's provenance and revision rules |
| Graphiti | Entity-relation graphs built from episodes, source links, bitemporal tracking and fact invalidation, hybrid retrieval | Python core; usually adds a Python process, graph backend, LLM, and embeddings; TypeScript integrates through a service boundary | More compelling when complex relationships, multi-hop questions, or historical relationship queries become explicit needs |
| Zep | Managed ingestion, context graphs, retrieval, and governance; distinct from the Graphiti open-source library | Hosted service or BYOC, with an official TypeScript SDK | Primarily buys operational and scaling capabilities; domain adaptation remains necessary |

### Letta / MemFS

MemFS organizes memories as Markdown files in a Git repository. Root-level memories enter each turn's system prompt; directories containing `MEMORY.md` are read on demand. There is no semantic or vector index by default. The optional MemFS Search mod provides keyword search without additional dependencies, while semantic and hybrid modes require QMD. Git preserves edit history, but finding a sentence in history does not answer what valid evidence supports an understanding or in which group it may be discussed. [Official MemFS documentation](https://docs.letta.com/concepts/memfs)

Letta's Dreaming uses background sub-agents to organize recent conversations and can add an Agent review step. [Memory & dreaming](https://docs.letta.com/configuration/memory) This resembles this project's separate memory review in mechanism. The presence of background consolidation alone does not determine whether to replace the system; identity, evidence, and write rules must also be compared.

At the review date, the `letta-ai/letta` repository identified the V1 API server in its `archive` branch as historical and `letta-code` as the active implementation. [Letta README](https://github.com/letta-ai/letta) Local processes and a self-hosted App Server were supported; the Agent SDK could connect remotely or run locally. [Self-hosting](https://docs.letta.com/self-hosting), [Agent SDK](https://docs.letta.com/agent-sdk) The `letta-code` source uses Apache-2.0, with separate license provisions for branding and other non-code assets. [LICENSE](https://github.com/letta-ai/letta-code/blob/6155d9f562f13eb1f352240a7fd07a87933ac76a/LICENSE)

**Inference:** A wholesale move to Letta would migrate the runtime, tools, and memory workflow, reopening the Pi choice in ADR-0009. Readable files, hierarchical directories, and change records could instead be added to the existing implementation. The official materials did not provide an equivalent interface that directly replaces this project's `writeMemory` constraints, so the effort should not be estimated as swapping a `MemoryStore`.

Git history is also not equivalent to this project's revision and forgetting semantics. Deleting the current file does not remove earlier Git history. Using a Git repository as authoritative memory storage would require invalidating dependent sources and clearing history, remote copies, and loaded working contexts; verifying that the current file is gone would not suffice.

### Mem0

Mem0's Node SDK can import `Memory` directly and accepts `userId`, `agentId`, `runId`, and metadata. The Node quickstart's default vector store is in-memory: a default SQLite history database does not mean vector memories are persisted. [Node SDK quickstart](https://docs.mem0.ai/open-source/node-quickstart) Server deployment also offers a Postgres + pgvector stack; inference, embeddings, and storage still need to be supplied or configured. [OSS overview](https://docs.mem0.ai/open-source/overview)

In the reviewed v3, `add` primarily adds memories incrementally and uses LLM extraction by default; `infer=false` stores the original text. [Add Memory](https://docs.mem0.ai/core-concepts/memory-operations/add) The official comparison distinguishes basic CRUD, history, and filtering in OSS from cloud capabilities such as graph memory, decay, temporal reasoning, and Dream. Older OSS tutorials connecting external graph databases or cloud demonstrations must not be treated as features built into the reviewed OSS version. [Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)

The reviewed TypeScript code implements scope, default extraction, raw-text writes, history, and manual updates and deletions. Its default write behavior is not this project's evidence-based `supersedes` rule. [TypeScript Memory implementation](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0-ts/src/oss/src/memory/index.ts) The repository uses Apache-2.0. [LICENSE](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/LICENSE)

**Inference:** Mem0 more directly addresses adding user facts and preferences to an application quickly. Here the Agent forms its own long-term understanding, requiring a mapping for QQ identities, multiple speakers' statements, external evidence versus inference, source records, scope propagation, and deletion propagation. Retaining existing write decisions through `infer=false` may reduce conflict, but also forgoes much of its automatic extraction value. `history` audits operations on a memory; it is not a source-dependency graph.

### Graphiti and Zep

Graphiti is an open-source temporal graph framework. Zep is a managed context platform built on this class of capabilities, with its own service components and deployment options. Zep and self-hosted Graphiti are not fully equivalent. [Official overview](https://help.getzep.com/graphiti/getting-started/overview)

Graphiti's `EntityEdge` retains fields including `episodes`, `valid_at`, `invalid_at`, and `expired_at`, expressing provenance and fact-validity time. This fits historical relationship queries more closely than version creation time alone. [edges.py](https://github.com/getzep/graphiti/blob/16bf514380de4e44884aed6779bece220e6fe470/graphiti_core/edges.py) LLM extraction and invalidation judgments still require evaluation; time fields do not prove factual correctness.

Graphiti's core is a Python library supporting backends such as Neo4j, FalkorDB, and Neptune, with an embedded FalkorDB Lite option; a separately deployed database is therefore not mandatory. Kuzu was deprecated in the reviewed version. The source uses Apache-2.0, and its reference REST/MCP server should not be treated as a ready-made production service. [README](https://github.com/getzep/graphiti/blob/16bf514380de4e44884aed6779bece220e6fe470/README.md), [LICENSE](https://github.com/getzep/graphiti/blob/16bf514380de4e44884aed6779bece220e6fe470/LICENSE)

Graphiti's `group_id` is a graph namespace separating entities and edges; applications must still authorize access and select namespaces. [Graph namespacing](https://help.getzep.com/graphiti/core-concepts/graph-namespacing) **Inference:** Mapping every QQ group to a fully separate graph does not by itself solve social scope and may split the identity of someone present in several groups. Conversely, a unified graph does not automatically preserve this project's sharing boundaries.

Zep has an official TypeScript SDK, and the reviewed documentation distinguished v4 from earlier interfaces. [v4 migration guide](https://help.getzep.com/v4/migrating-from-v3) Hosted or BYOC offerings provide service and operational value; their product capabilities are not all licensed by Graphiti's open-source license. [Graphiti and Zep deployment boundaries](https://help.getzep.com/graphiti/getting-started/overview)

## When a migration would be justified

Choose the appropriate layer to migrate when one of these conditions appears and is validated against real samples:

1. **Retrieval scale becomes a bottleneck:** Vector scanning or index maintenance measurably affects latency, memory use, or rebuild time. Replace indexing and retrieval first, without moving continuing state or authoritative source records.
2. **Relationship and temporal reasoning become frequent needs:** Many questions depend on multi-hop relationships, views valid at a particular time, or changes in relationships. Start by giving Graphiti copies of existing records and comparing historical queries.
3. **Deployment and operation become the main cost:** Evaluate managed Mem0/Zep costs and data boundaries when multiple instances, multiple users, service governance, or availability commitments are needed.
4. **An intentional Agent-platform redesign is chosen:** Adopting Letta's complete state, tool, and memory workflow should be assessed separately as a Pi runtime migration. It is a different task from improving one retrieval function.

## Proposed next steps from this investigation

First collect approximately 50–100 real memory failures and successes. Label the material available at the time, what should have been found, and whether the failure was a missing record, incorrect understanding, missed retrieval, failure to use a retrieved memory, or inappropriate scope. Replay samples chronologically to avoid answering earlier questions with memories formed later.

Build read-only auxiliary indexes for candidate approaches from existing records. Hold the memory candidate count and prompt budget constant. Measure retrieval correctness, irrelevant injection, provenance completeness, superseded versions that remain active, cross-group scope errors, residual data after deletion, latency, model calls, and operational costs separately. Distinguishing actual from fictional experience, source chains, revision and deletion propagation, and continuing-state recovery are hard migration constraints; average retrieval scores cannot compensate for violating them.

Discuss dual writes or a gradual transition only after a candidate consistently improves these cases. At the review date, no evidence supported directly handing existing data to another automatic extractor to regenerate memories, nor was there sufficient evidence to claim that any external option would necessarily outperform the existing implementation.

## Source snapshots examined

To avoid drift with `main`, key source links are pinned to commits returned by the GitHub API during the investigation: Mem0 `753496cf1435d76c3a711f3af51303f7fdcb6420` (2026-10-30), Graphiti `16bf514380de4e44884aed6779bece220e6fe470` (2026-11-01), and Letta Code `6155d9f562f13eb1f352240a7fd07a87933ac76a` (2026-11-02). These are default-branch snapshots examined at that time, not claims that this project installed or validated those versions. Unpinned documentation and repository links may change; they preserve the original source locations rather than guaranteeing a reproducible snapshot.
