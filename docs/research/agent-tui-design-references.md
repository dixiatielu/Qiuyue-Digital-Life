# Agent TUI design references and directions for Qiuyue's interface

Reviewed: 2026-11-04. This investigation checked official documentation and public source code; it did not install or run the reference products. Confirmed product behavior and design recommendations for this project are distinguished below. Online documentation will continue to change; source links are pinned to the commits obtained during this investigation.

## Conclusion

Keep Qiuyue's current structure of identity at the top, a central timeline, and administrative commands at the bottom. Focus on information hierarchy and reading rhythm: make **Qiuyue's current state, recent events, confirmed external actions, and exceptions requiring attention** visible at a glance. Expand tool arguments, raw records, and runtime statistics on demand.

Claude Code offers references for a quiet main reading area and progressive disclosure; OpenClaw for clearly expressing connection state, runtime state, and tool execution; OpenCode for command discovery, semantic themes, and layouts that adapt to window width. These are design choices, not a claim that the three products share one layout.

## Behavior confirmed by official sources

### Claude Code: separate the main reading area from detailed records

- The normal view consolidates some repeated tool calls; `Ctrl+O` opens the transcript viewer for detailed execution information. Typing `/` lists and filters commands, and `?` shows shortcuts when the input is empty. The relevant idea is the hierarchy of detail, rather than copying every key binding. [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- Officially, both classic and fullscreen rendering paths are available. Fullscreen remains a research preview, so Claude Code cannot be described simply as using only native terminal scrolling. Fullscreen fixes the input at the bottom and renders only visible messages; scrolling away from the bottom stops automatic following and shows a new-message count and a way to return to the bottom. Collapsed tool results can be expanded by clicking. [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen)
- A custom status line has its own position and can continuously show the model, context, cost, and other information. The documentation places it above the built-in footer badges and notes that configuring it also affects default shortcut hints. Adding a status bar therefore requires considering vertical space and hint priorities. [Status line](https://code.claude.com/docs/en/statusline)

**Implications for Qiuyue:** Keep readable results in the main view; detailed records are another presentation layer over the same data. Fixed input, scrolling back without losing focus, and new-message hints all contribute to reading comfort. Qiuyue already has these foundations and need not rebuild them because a reference product does.

### OpenClaw: give persistent state, tool progress, and body text their own places

- The documented interface distinguishes the header, chat log, runtime/connection status, footer, and autocomplete editor. Tool calls update their arguments and results within one card, with `Ctrl+O` toggling expansion; reconnections and event gaps are explicit. Body text uses the terminal's default foreground color, with light/dark overrides available. [TUI](https://docs.openclaw.ai/web/tui)
- The pinned theme source names text, muted text, accents, borders, user backgrounds, and backgrounds for tools in progress, successful tools, and failed tools separately. The dark theme uses a warm gold accent. Assistant body text has no forced tint; user messages and tool feedback have their own visual treatment. [theme.ts](https://github.com/openclaw/openclaw/blob/45c571ed441ba4548f0fa3a7f625302e13ed3c87/src/tui/theme/theme.ts)
- Tool components start collapsed and limit previews to the available width. Progress, completion, and errors change the state and background of the same component instead of appending a new log entry for each update. [tool-execution.ts](https://github.com/openclaw/openclaw/blob/45c571ed441ba4548f0fa3a7f625302e13ed3c87/src/tui/components/tool-execution.ts)

**Implications for Qiuyue:** A healthy connection, an Agent thinking, an Agent resting, and Agent Pause are distinct facts and should appear distinctly. Adopt in-place updates and explicit receipts without copying OpenClaw's multiple-Agent/session selectors.

### OpenCode: command discovery, semantic themes, and width adaptation

The default development branch found during this investigation was already v2, which is the basis below. Commands and configuration formats in the older `/docs/tui/` should not be treated as the current v2 behavior.

- In v2, typing `/` filters commands, and `Ctrl+P` opens the current view's command palette. Common operations involving the editor, model, Agent, and sessions have discoverable entry points. [v2 TUI](https://opencode.ai/v2/docs/cli/tui/)
- v2 themes use semantic tokens. The theme name `system` derives colors from the terminal palette, while the mode `system` follows the terminal's light/dark setting; these have different meanings. Body text, muted text, feedback, interaction states, and panel depth each have their own tokens. [v2 Theme](https://opencode.ai/v2/docs/cli/theme/)
- In the pinned source, user messages use a left-side marker and background hierarchy. The input area likewise uses a left border, padding, body text, and metadata rather than requiring a four-sided box around every region. Horizontal margins shrink below 44 columns. [session/index.tsx](https://github.com/anomalyco/opencode/blob/8b038f672b0ee520d3ab6bc1014fc3eddba5961c/packages/tui/src/routes/session/index.tsx), [prompt/index.tsx](https://github.com/anomalyco/opencode/blob/8b038f672b0ee520d3ab6bc1014fc3eddba5961c/packages/tui/src/component/prompt/index.tsx)
- Panel layouts preserve a minimum width for the main content. When space runs out, the panel takes over the screen instead of squeezing two columns further. [layout.ts](https://github.com/anomalyco/opencode/blob/8b038f672b0ee520d3ab6bc1014fc3eddba5961c/packages/tui/src/ui/layout.ts)

**Implications for Qiuyue:** Establish a small, explicit set of theme semantics and make administrative commands discoverable by typing `/`. Keep one column by default; show additional information only when needed and space permits. A separate thinking-visibility toggle is also useful; the v2 key-binding documentation explicitly lists it as a visibility operation. [v2 Keybinds](https://opencode.ai/v2/docs/cli/keybinds/)

## Existing foundations in this project

At the time of inspection, [src/tui.ts](../../src/tui.ts) already provided an alternate screen, fixed bottom input, scroll following and new-entry hints, run grouping, per-item collapse, compact/detailed modes, filtering, Markdown, busy animations, streaming progress, and disconnection hints. Each event updates by ID, and rendering is cached. [src/display-client.ts](../../src/display-client.ts) reconnects the observer without starting the daemon or opening the life database.

The current interface should therefore not be described as merely a scrolling log, nor should switching to Ink, OpenTUI, or another framework be a prerequisite for improving its appearance. Validate visual changes on the existing pi-tui components first.

## Proposed design directions (not implemented)

### 1. Keep one primary emphasis per screen

Keep "☾ Qiuyue" as a lightweight identity marker, with a muted moon-purple accent for the current focus, selection, and active phase. Use the terminal's default foreground for ordinary body text and muted text for times, native tool names, and auxiliary counts. Green means confirmed success, yellow means pending confirmation or an unknown outcome, and red means failure. Color must not be the only way to convey state.

Define seven basic semantics: `text`, `muted`, `accent`, `border`, `success`, `warning`, and `error`. Light, dark, and terminal-default themes should share components. Reduce unnecessary bright colors, labels, and repeated icons before considering more themes.

### 2. Organize the timeline around what happened

Replace the default run summary's emphasis on "Run finished · statistics" with a scannable event result, such as "Music group · 3 messages received · 1 reply sent". Expansion shows observations, tool execution, external actions, and their outcomes. Summaries must come from recorded facts, not from inferring delivery from model text.

Leave one blank line between runs and use consistent indentation within a run. Emphasize sources and participants over repeated timestamps; show precise times within a group only where necessary. Compress ordinary tools to one line: "Action name · target · status/duration", with native names, arguments, and results available on expansion. Full-detail mode retains precise timestamps and fields.

The current code hides normal action child entries by default. Confirmed outgoing message content could appear in the run summary or a readable action line, giving a sense of the digital life's activity. Preserve the distinction among pending, success, failed, and unknown; an `Unknown Action Outcome` must not appear as failure or success.

### 3. Replace the long statistics line with two levels of status

The persistent level shows identity, whether the Agent is paused, the main runtime phase, and daemon/QQ connectivity; context capacity appears when space permits. Put statistics such as today's calls and this hour's actions in `/status` or details, where they do not compete with the current situation.

During execution, show one line above the input, such as "Searching memory · 3s" or "Waiting for model response · 8s". Streaming chunk counts and the time of the last output remain available; promote them to a visible hint when a wait becomes long. No output yet does not mean the process is stuck.

`Rest` and `Agent Pause` require different wording; the latter still receives and saves environment events. Show unknown when the state is unavailable, rather than inferring rest from a lack of output.

### 4. Make administrative commands discoverable

Keep the input explicitly labeled "Administrative commands"; a light separator or local background is sufficient. Typing `/` opens a filterable list containing each command, a short description, and its current availability. For example, `/resume` means "Resume thinking and autonomous actions". Esc closes the list while preserving the input.

The footer shows only three or four shortcuts relevant to the current context. Put full help in a dismissible panel so a long explanation does not permanently crowd the timeline. Preserve existing bindings such as `Tab` to expand and `Alt+↑/↓` to select, or provide an explicit migration.

### 5. Make exceptions stable, clear entries

For failures, show which action was involved, what it affects, and the currently known outcome; expand to see the raw stack trace. Give "Outcome unknown" its own text and symbol without automatically recommending a retry. Perception gaps, disconnections, and recoveries should leave concise timeline entries, while the status area shows current connectivity; transient hints alone are insufficient.

Preserve the scroll position when filtering or reviewing history. Keep the new-entry count and "Return to live" control discoverable without forcing a jump to the bottom.

## Domain boundaries

- This project has one continuing Agent. Group chats are Group Environments, not independent Agents. Group filtering may change only the view; it must not imply switching persona or long-term memory. [GLOSSARY](../../GLOSSARY.md), [ADR-0001](../adr/0001-one-agent-across-group-environments.md)
- This TUI is an Operator management interface. Changing its input hint to a conversational "Ask anything" would blur the boundary between administrative commands and Social Requests and is outside these visual recommendations. [ADR-0003](../adr/0003-separate-runtime-control-from-social-requests.md)
- Continue using the existing control and subscription capabilities, leaving complex configuration editing to the management page. A visual upgrade does not require moving the daemon, database writes, or credential management into the TUI. [ADR-0009](../adr/0009-embedded-pi-with-local-state-and-cli.md), [ADR-0020](../adr/0020-a-management-page-apart-from-the-daemon.md)

These recommendations do not conflict with existing ADRs. Future input modes for chatting directly with Qiuyue or sending into a group would need a separate design for destinations and permission semantics.

## Proposed sequence and acceptance scenarios

1. **Appearance and hierarchy first:** theme semantics, timeline spacing, run summaries, status-field selection, and a lightweight input area.
2. **Interaction next:** command completion, clear selection states, a help panel, and discoverable detail-level controls.
3. **Extended-use validation last:** mixed Chinese/emoji text, narrow screens and long tool names, stable streaming updates, no jumps to the bottom while reviewing history, accurate state after disconnection, and readability in light terminals.

Check at least 80×24 and 120×32 terminals in these states: idle, thinking, tool execution, awaiting a message receipt, successful external action, unknown outcome, Agent Pause, and disconnection/reconnection. The aim is to make the same data easier to read without letting decoration consume more rows.

## Local rendering check and design previews

The current `DisplayModel` and `Timeline` rendering functions were run directly at 80 columns with synthetic Chinese example events, without connecting to real QQ or calling a model. The default output for a completed run contained only the following, translated into English here:

```text
✓ 20:41:00 Run finished · 8s · 1 action succeeded · 2 model requests · 2 tools ▸
```

The triggering message and the sending tool's content summary appeared only after expansion. Normal action entries were still omitted, while "Model output · Not sent to QQ" appeared with its full body. This indicates that the priority should be retaining readable results of actual external actions and collapsing technical execution details; changing colors alone cannot fix the hierarchy. [Timeline implementation](../../src/tui.ts), [Sources for action states and run summaries](../../src/monitor.ts)

The design previews in the conversation offered "Conversation first" and "Compact observation" variants. Both used example data and had not been applied to the actual TUI. The previews supported expanding tool details, filtering administrative commands, and switching themes and runtime states through design controls. The web mockups expressed information hierarchy and terminal character layout; the actual terminal must still respect the character grid, CJK width, and terminal palette. Browser layout checks cannot replace terminal acceptance checks.

For implementation, start with rendering and theming in `src/tui.ts`: retain sent content, de-emphasize repeated times and native tool names, reduce persistent statistics, and clearly distinguish body text from model output. `src/monitor.ts` already provides action arguments, states, and sources as a basis for displaying results. Combining a tool and an action into one expandable entry would require an explicit correlation identifier, not guesses from message content or adjacency. Where fields such as group names or rest state are not explicitly available, continue using existing source identifiers and known states rather than inferring them in the interface.
