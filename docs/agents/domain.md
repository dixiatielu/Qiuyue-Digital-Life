# Domain Docs

## Layout

This repo uses a single-context layout:

- `GLOSSARY.md` at the repo root defines domain vocabulary.
- `docs/adr/` stores architecture decision records.

## Before exploring

Read the root glossary and ADRs relevant to the area being explored.

If these documents do not exist, proceed silently.
The `domain-modeling` skill creates them when terms or decisions
are resolved.

## Vocabulary

Use glossary terms when naming concepts in issues, proposals,
hypotheses, and tests. For an undefined concept, reconsider whether
it belongs to the domain or note the gap for `domain-modeling`.

## Decision conflicts

Explicitly identify any proposal that conflicts with an existing ADR,
cite that ADR, and explain why the decision should be reconsidered.
