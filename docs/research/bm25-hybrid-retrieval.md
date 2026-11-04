# BM25 and hybrid retrieval for digital-life memory

Reviewed: 2026-10-30. This investigation used official documentation, repository source code, and papers; it did not run a retrieval benchmark. The local experiment used Node's built-in SQLite (3.53.4) to check FTS5 behavior, not to evaluate the complete system. This is a research snapshot; see [src/store.ts](../../src/store.ts) for the current implementation and [Memory system options](memory-system-options.md) for the subsequent comparison. Branch-based source links below are mutable and do not pin the exact code reviewed on that date.

## Findings

- For Chinese personal-memory corpora, **tokenization is the main problem, rather than BM25 itself**. FTS5's default unicode61 tokenizer treats an uninterrupted run of Chinese characters as one token; trigram requires at least three characters in a query. Neither directly handles common two-character Chinese words.
- The lexical branch has a more basic limitation: runs of letters, numbers, and underscores often produce a whole Chinese sentence as one search term. Both `instr()` and FTS then depend on matching that uninterrupted text. BM25 ranking cannot recover candidates lost through poor query segmentation.
- BM25's expected strength is **exact tokens**: QQ IDs, names and nicknames, group IDs, dates, English abbreviations, and proper nouns. Dense retrieval's expected strength is **paraphrases, synonyms, cross-language matches, and loosely expressed emotions**. They are complementary.
- RRF consumes ranks, not raw scores. At the project's scale of hundreds to thousands of memories for one operator, ordering the lexical list by `bm25()` before fusion does not require a new score-normalization formula. Candidate coverage and ranking quality still need evaluation.

## 1. mem0 OSS (main / v3)

In the reviewed implementation, mem0's `_search_vector_store` combined semantic retrieval with BM25 weighting. It first fetched `max(limit*4, 60)` vector results, then fetched keyword results from vector stores supporting `keyword_search`, applied sigmoid normalization, and ranked by `combined = (semantic + bm25 + entity_boost) / max_possible`. [memory/main.py](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py), [utils/scoring.py](https://github.com/mem0ai/mem0/blob/main/mem0/utils/scoring.py)

The key detail is that **BM25 could not introduce new candidates**. `score_and_rank` iterated only over `semantic_results`, and candidates below the semantic threshold were discarded before fusion. BM25 only boosted memories already retrieved by the vector search. A vector store without `keyword_search` triggered a warning and fell back to semantic search. Before BM25, spaCy lemmatization also produced a `text_lemmatized` payload field. [main.py](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py), [lemmatization.py](https://github.com/mem0ai/mem0/blob/main/mem0/utils/lemmatization.py)

For this project, mem0 illustrates BM25 as a reranking signal rather than an independent retrieval source. A dense-selected candidate pool can conceal Chinese tokenization weaknesses, but an exact-ID query cannot recover a memory the vector search omitted.

## 2. Zep / Graphiti

Graphiti's reviewed full-text retrieval used graph-database full-text indexes, rather than SQLite. The Neo4j implementation created `CREATE FULLTEXT INDEX ... IF NOT EXISTS` indexes and queried them through `CALL db.index.fulltext.queryNodes(...)`, using Lucene query syntax after `lucene_sanitize`. [graph_queries.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/graph_queries.py), [neo4j/search_ops.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/driver/neo4j/operations/search_ops.py)

The parallel retrieval methods were `bm25` and `cosine_similarity`. The default `COMBINED_HYBRID_SEARCH_RRF` recipe used both with RRF for edges, nodes, and communities; episodes used BM25 with RRF. Cross-encoder recipes provided a more expensive reranking option. [search_config_recipes.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_config_recipes.py)

One easily missed difference was the default `rank_const=1` in Graphiti's `rrf()`: the first result contributed 1.0 and the second 0.5, a much steeper falloff than the common k=60 setting. Saying that a system uses RRF does not fully specify its behavior; the rank constant is itself a hyperparameter. [search_utils.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_utils.py)

## 3. Letta (MemGPT)

At the review date, the Letta V1 server had moved to the `archive` branch. Its archival-memory search had two paths:

| Archival backend | Retrieval implementation | Lexical channel |
| --- | --- | --- |
| Native SQL (Postgres + pgvector) | `ORDER BY embedding <=> query_embedding` (`cosine_distance`), with empty metadata | None; no tsvector |
| Turbopuffer | `multi_query`: vector ANN plus `("text","BM25",query)`, fused with RRF | BM25 |

The native path sorted only by cosine distance. The hybrid path used `search_mode="hybrid"` and returned `rrf_score`, `vector_rank`, and `fts_rank`; its RRF used k=60 and default vector/FTS weights of 0.5 each. [helpers/agent_manager_helper.py](https://github.com/letta-ai/letta/blob/archive/letta/services/helpers/agent_manager_helper.py), [agent_manager.py](https://github.com/letta-ai/letta/blob/archive/letta/services/agent_manager.py), [helpers/tpuf_client.py](https://github.com/letta-ai/letta/blob/archive/letta/helpers/tpuf_client.py)

Thus, saying that Letta uses pgvector describes only part of the implementation: **native archival search was vector-only; hybrid retrieval was an optional capability supplied by a commercial vector backend**. The reviewed `letta-code` MemFS workflow had no semantic index by default and was less directly relevant to this comparison.

## 4. Stanford Generative Agents

The paper combined recency, importance, and relevance after min-max normalization. Relevance was cosine similarity between embeddings of the memory text and query memory. Recency used exponential decay over sandbox hours (0.995), while an LLM scored importance. Retrieval had no lexical or BM25 channel. [Generative Agents, section 4.1.2](https://arxiv.org/html/2304.03442v2)

An inference from the query format is that BM25 was less central because queries described the current situation, rather than consisting of user-entered keywords, and the memory stream contained natural-language accounts. Exact-ID matching was not the main requirement. The paper studied plausible behavior in a simulated environment, not retrieval recall; its choice cannot be directly transferred to personal memory that must find someone by QQ ID.

## 5. Observed SQLite FTS5 behavior

- `bm25()` returns a real number, and **smaller values mean greater relevance**. The standard ordering is `ORDER BY bm25(ft)`; scores depend on query phrases and document term statistics. [FTS5 section 5.1.1](https://sqlite.org/fts5.html#the_bm25_function)
- The trigram tokenizer indexes each sequence of three consecutive characters and supports substring matching. **Substrings shorter than three Unicode characters match no rows**. With `detail=none/column`, query tokens cannot exceed three characters. [FTS5 section 4.3.4](https://sqlite.org/fts5.html#the_trigram_tokenizer)
- By default, unicode61 treats Unicode categories `L*`, `N*`, and `Co` as token characters and makes each uninterrupted run a token. Chinese characters belong to `Lo`, so **an uninterrupted Chinese phrase without spaces or punctuation becomes one token**. [FTS5 section 4.3.1](https://sqlite.org/fts5.html#unicode61_tokenizer)
- The recorded local experiment used SQLite 3.53.4 and the synthetic Chinese text `"\u6211\u4eca\u5929\u5fc3\u60c5\u5f88\u597d\uff0c\u60f3\u53bb\u516c\u56ed"` ("I feel good today and want to go to the park"). Language-specific literals here use JavaScript/JSON Unicode escapes; decode them before passing them to SQLite, which does not interpret these escapes in SQL string literals. On a trigram table, a `MATCH` query for the decoded two-character term `"\u5fc3\u60c5"` ("mood") returned zero rows, while `"\u5fc3\u60c5\u5f88"` ("mood" followed by the character meaning "very") returned one. A unicode61 vocabulary contained `["\u60f3\u53bb\u516c\u56ed", "\u6211\u4eca\u5929\u5fc3\u60c5\u5f88\u597d"]` ("want to go to the park" and "I feel good today"), and a query for `"\u5fc3\u60c5"` returned zero rows. The original character boundaries are the subject of the experiment.

Consequently, an FTS branch using `tokenize='trigram'` and `term.length >= 3` cannot match two-character Chinese words such as `\u5fc3\u60c5` (mood), `\u5317\u4eac` (Beijing), or `\u5988\u5988` (mother). The reviewed `Store.search` also had `instr()` substring matching, which could still find these terms; this FTS limitation was not a limitation of the entire search. The FTS branch did not call `bm25()`. Adding that ordering could change the rank of matched candidates, but could not recover candidates missed through tokenization.

## 6. Benchmark evidence for BM25 versus dense retrieval

BEIR compared lexical, sparse, dense, late-interaction, and reranking methods across 18 datasets. **BM25 was a robust zero-shot baseline**. Dense and sparse methods were computationally efficient but often underperformed BM25 and other methods in zero-shot settings; reranking and late-interaction methods performed best on average at greater cost. [BEIR, Thakur et al. 2021](https://arxiv.org/abs/2104.08663)

These results concern document retrieval across domains, not personal memory. They suggest that dense retrieval should not be assumed to dominate BM25 on a small, specialized corpus; they do not establish a corpus-size rule or predict this project's results. BM25's familiar weaknesses are inflection, synonyms, and paraphrases, while rare exact tokens are a strength relevant to QQ IDs, nicknames, group IDs, and dates.

## 7. Chinese segmentation: jieba, trigram, and bigram

jieba builds a DAG from a prefix dictionary, uses dynamic programming to select the most probable path, and handles unknown words with HMM and Viterbi. Its `cut_for_search` mode further splits long words from accurate-mode segmentation for search indexing. [jieba README](https://github.com/fxsjy/jieba)

The expected effects on FTS are:

| Approach | Two-character word `\u5fc3\u60c5` (mood) | Strengths | Limitations |
| --- | --- | --- | --- |
| trigram | No match: fewer than three characters | No added dependency; substring matching | Misses two-character terms; larger index |
| Raw unicode61 | No match within an uninterrupted phrase | Works for English and numbers | Poor segmentation of Chinese |
| unicode61 with jieba preprocessing | Matches as one word token | Word-level IDF; segmentation closer to Chinese usage | Writes and queries must use the same dictionary; nicknames and out-of-vocabulary words may be split incorrectly |
| Single-character or bigram index | Matches, with more noise | No dictionary needed | Frequent characters such as `\u7684` (a possessive/attributive particle), `\u6211` ("I"), and `\u662f` ("to be") dilute IDF |

Two-character words are common in modern Chinese, while trigram requires three characters. **Keeping trigram and adding `bm25()` ordering therefore offers limited help with this specific problem**. More promising approaches are a segmented word index, or retaining `instr()` for exact entities while using vectors for semantics.

## 8. Recommendations from this investigation

These are hypotheses for evaluation, not accepted implementation requirements.

1. **Keep dense retrieval and RRF rather than replacing the dense branch with BM25.** RRF uses ranks, so negative BM25 scores and differing score scales do not disrupt fusion.
2. **Improve lexical segmentation first.** Avoid treating an entire uninterrupted Chinese sentence as one term. For `instr()`, consider the original query or whitespace-stripped substrings; for FTS, use jieba or equivalent dictionary segmentation to create `title_seg`/`content_seg` shadow columns on write, and segment queries consistently.
3. **Evaluate `tokenize='unicode61'` with presegmented text.** If trigram remains, treat it as a fallback for terms of at least three characters and accept that its FTS path cannot find shorter terms.
4. **Use BM25-ranked FTS results as an independent lexical candidate source.** Retrieve a top-K list, such as 50 results, ordered by `bm25()`, then fuse it with the vector list through RRF. This allows the lexical path to introduce candidates the vector path missed. Evaluate separately where and how person, group, importance, and recency signals affect ranking.
5. **Consider a custom dictionary for nicknames, group names, and QQ IDs**, while retaining original text for display and exact `instr()` matching.
6. Compare lexical recall and ranking on offline examples rather than predicting gains from corpus size alone. RRF can combine rankings with different score scales, but its constant, candidate counts, and subsequent weighting still need validation.

Validate Chinese segmentation and candidate coverage before measuring the benefit of BM25 ranking. Adding `bm25()` to trigram will not make that FTS branch match two-character words, although the existing substring branch can still handle them.
