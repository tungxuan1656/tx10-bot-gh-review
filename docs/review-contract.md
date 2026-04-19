# Review Contract

## Purpose

The Codex prompt contract keeps the review pipeline deterministic. The bot asks Codex for a JSON object only, validates it with Zod, checks that the returned decision matches the findings severity policy, and only then maps the result to a GitHub review event.

## Required Output Schema

```json
{
  "summary": "string",
  "score": 0,
  "decision": "approve|request_changes",
  "findings": [
    {
      "severity": "critical|major|minor|improvement",
      "path": "string",
      "line": 1,
      "title": "string",
      "comment": "string"
    }
  ]
}
```

## Prompt Rules

- Copy `resources/review-skills/*` into the temporary workspace `.agents/skills` before invoking Codex
- Initial review flow uses 2 phases: metadata summary then deep JSON review
- Re-review flow uses 1 fast JSON phase focused on commit delta from the latest successful bot-reviewed SHA
- Instruct Codex to use the bundled `code-review` skill for the deep initial phase
- Instruct Codex to inspect changes directly from workspace refs with git commands:
  - `git diff --name-status refs/codex-review/base refs/codex-review/head`
  - `git diff --unified=5 refs/codex-review/base refs/codex-review/head`
  - `git show refs/codex-review/head:<path>` when deeper file context is needed
- Instruct Codex to read `pr-review-comments.md` from workspace for historical context
- JSON only
- No markdown fences
- No stylistic-only findings
- Only findings backed by a specific file path and line number grounded in visible diff hunks
- Focus on correctness, bugs, security, and missing validation

Optional JSON field:

- `changesOverview` key must always be present in model JSON to satisfy the output-schema contract.
- When there is no meaningful overview, set `changesOverview` to an empty string.
- Publishing logic treats empty `changesOverview` as absent and does not render a section.

## Deterministic Decision Mapping

| Finding set | GitHub review event |
| --- | --- |
| At least one `critical` or `major` | `REQUEST_CHANGES` |
| Only `minor` or `improvement` | `APPROVE` |
| No findings | `APPROVE` |

`score` is informational only and is included in the review body.

If Codex returns a `decision` that does not match the findings severity policy, the service does not publish a review. It posts a neutral failure comment instead.

## Failure Handling

- Non-zero Codex exit code => create one neutral PR comment
- Timeout => create one neutral PR comment
- Invalid JSON or schema mismatch => create one neutral PR comment
- Invalid inline location => keep the finding in the top-level summary instead of failing submission

## File Selection Policy

Review only:

- `.js`
- `.jsx`
- `.ts`
- `.tsx`
- `.py`
- `.java`

Skip:

- `node_modules/`
- `dist/`
- `build/`
- lockfiles
- files without a reviewable patch
