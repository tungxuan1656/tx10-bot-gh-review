# Review Contract

## Purpose

The Codex prompt contract keeps the review pipeline deterministic. The bot asks Codex for a JSON object only, validates it with Zod, and derives the final GitHub review state from the findings list rather than from free-form wording.

## Required Output Schema

```json
{
  "summary": "string",
  "score": 0,
  "decision": "approve|comment|request_changes",
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "path": "string",
      "line": 1,
      "title": "string",
      "comment": "string"
    }
  ]
}
```

## Prompt Rules

- JSON only
- No markdown fences
- No stylistic-only findings
- Only findings backed by a specific file path and line number
- Focus on correctness, bugs, security, and missing validation

## Deterministic Decision Mapping

| Finding set | GitHub review event |
| --- | --- |
| At least one `critical` or `high` | `REQUEST_CHANGES` |
| Only `medium`, `low`, or `info` | `COMMENT` |
| No findings | `APPROVE` |

`score` is informational only and is included in the review body.

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
