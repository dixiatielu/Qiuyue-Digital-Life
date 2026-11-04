# Contributing

Contributions to the code, documentation, and project direction are welcome. You may write issues and pull requests in English or Chinese.

## Reporting issues

Search existing issues before opening a new one. Use the bug report or feature request form when applicable; blank issues remain available for other topics. Requirements and specifications belong in GitHub Issues; pull requests provide implementations.

- **Bug reports:** Include the version or commit, Node.js version, operating system, minimal reproduction steps, expected and actual behavior, and sanitized logs. Include adapter and plugin names and versions when relevant.
- **Feature requests:** Describe the use case, proposed behavior, acceptance criteria, and effects on existing configuration, data, or plugins. Discuss substantial features or architecture changes in an issue before implementation.
- **Private information:** Use synthetic or sanitized examples. Keep API keys, tokens, private chat records, personal information, `config.json`, `credentials.json`, and runtime databases out of public issues, pull requests, and test fixtures. For exploitable vulnerabilities, use private vulnerability reporting if enabled; otherwise, ask the maintainer for a private contact channel before sharing details.

Maintainers use the [five canonical triage labels](docs/agents/triage-labels.md) to track status. A label indicates the current state, not a delivery commitment.

## Submitting pull requests

1. Create a branch from `main` and keep each PR focused on one problem. Link the relevant issue when implementing an existing request; use `Fixes #123` when the PR resolves that issue.
2. Explain the behavior before and after the change, why it is needed, and what you actually verified. Include screenshots for UI changes and upgrade and rollback instructions for changes to persistent data or configuration formats.
3. Read [GLOSSARY.md](GLOSSARY.md) and the relevant [ADRs](docs/adr/). Follow the existing vocabulary and architecture. If a change revises an existing decision, cite the ADR and explain why it should change.
4. Add meaningful tests for behavior changes. Documentation-only changes and changes that do not affect behavior do not require tests for their own sake. Update affected documentation, configuration examples, and public interface guidance.
5. AI-assisted contributions follow the same requirements. Contributors are responsible for understanding their changes, checking dependencies and licenses, and accurately reporting validation results and known limitations.

## Local checks

Use the Node.js version specified in `.nvmrc`, then run the same checks as CI from the project directory:

```bash
nvm use
npm ci
npm run sync:snowluma
npm run check
npm test
npm run build
```

Run tests relevant to your change before the full checks. If you cannot complete a check, state the command, reason, and impact in the PR. Update generated API catalogs through the repository's synchronization scripts and check for unrelated changes.

## Review priorities

- Preserve the Agent's unified identity, memory, and continuing state. Interactions across groups and platform accounts follow the existing domain model.
- Preserve the boundary between runtime management and social requests. Follow the relevant ADRs for pause behavior, configuration, and control of the core persona.
- Preserve unknown action outcomes. A timeout, cancellation, or restart does not prove failure and must not cause blind retries of external actions.
- When changing storage, migrations, deletion, or recall, account for evidence provenance, related indexes, and dependent content.
- When changing adapters, plugins, or configuration, explain compatibility effects and respect the configured capability boundaries.

## Codex PR review

This repository uses ChatGPT's Codex GitHub integration, with review rules in [AGENTS.md](AGENTS.md). A maintainer must connect the repository and enable automatic review in ChatGPT; see the [official setup guide](https://learn.chatgpt.com/docs/third-party/github). These Markdown files do not enable the remote settings themselves.

Once the integration is enabled, maintainers can also comment `@codex review` on a PR to request a review. Check the specific findings, add verification where needed, and explain how you addressed them. Automated review complements CI and does not constitute maintainer approval.

The current scope is PR review. Maintainers continue to triage issues through the process above and make the final decisions on accepting requests and merging changes.
