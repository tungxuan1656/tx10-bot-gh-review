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

- Build the prompt from the exact temporary workspace diff between `baseSha` and `headSha`
- Copy `resources/review-skills/*` into the temporary workspace `.agents/skills` before invoking Codex
- Instruct Codex to use the bundled `code-review` skill
- JSON only
- No markdown fences
- No stylistic-only findings
- Only findings backed by a specific file path and line number
- Focus on correctness, bugs, security, and missing validation

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
