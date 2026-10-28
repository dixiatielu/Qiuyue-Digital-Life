# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `dixiatielu/qiuyue-digital-life`.
Use the `gh` CLI from this checkout, or pass
`--repo dixiatielu/qiuyue-digital-life` explicitly.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,assignees`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Update body: `gh issue edit <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number>`.
- Create a child issue: `gh issue create --parent <parent> --title "..." --body-file <file>`.
- Link an existing child: `gh issue edit <parent> --add-sub-issue <child>`.

Write multiline bodies to a temporary file and pass `--body-file`.
Use `triage-labels.md` for triage role mappings.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read that issue and its comments.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Children: sub-issues of the map, labelled `wayfinder:<type>`,
  where type is `research`, `prototype`, `grilling`, or `task`.
- If sub-issues are unavailable, use a task list in the map and
  `Part of #<map>` in each child.
- Blocking: `gh issue edit <child> --add-blocked-by <blocker>`.
  If native dependencies are unavailable, use `Blocked by: #<number>`
  in the child body.
- Frontier: inspect the map's open children in map order. Select the
  first unassigned child whose blockers are all closed.
- Claim: `gh issue edit <number> --add-assignee @me` before working.
- Resolve: post the answer, close the child, then add a summary and
  issue link to the map's Decisions-so-far.
