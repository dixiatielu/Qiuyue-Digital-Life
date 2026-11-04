## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. Read `docs/agents/issue-tracker.md` before tracker operations.

### Triage labels

Use the five canonical triage labels. Read `docs/agents/triage-labels.md` before applying or changing triage labels.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Read `docs/agents/domain.md` before exploring the codebase.

## Documentation language

Write all documentation under `docs/research/` in English.

## Code Review Rules

For Issue triage and PR review, read `CONTRIBUTING.md` and the relevant ADRs. Report actionable problems with evidence, their impact, and the affected file and line when applicable.

Review findings must identify problems introduced by the change. Distinguish verified behavior from inference and state validation limits. Use the PR's language for feedback.

- Runtime control stays in the administrative interface. Ordinary chat messages, including the operator's, remain social requests; preserve pause semantics and operator control of the core persona (ADR-0003).
- Preserve unknown action outcomes. A timeout, cancellation, or restart does not prove failure; verify the outcome before repeating an external action (ADR-0008).
- Memory deletion must also handle dependent indexes, summaries, and understanding so deleted content cannot reappear through recall (ADR-0003).
