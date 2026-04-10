# Code Review Guide (Single Source, Full Strict)

Single source for process, rule catalog, and review output.

## 1) Goal

Review tightly and reproducibly for one project.
Focus: prevent semantic, design, performance, and regression defects before merge.

## 2) Severity, Decision, Merge

- `Critical`: wrong behavior, data loss, crash, i18n key mismatch, security/privacy breach, mandatory pattern violation.
- `Major`: high UX/performance/maintainability/test impact.
- `Minor`: readability/style/low-risk optimization.

Merge policy:

- Any unresolved `Critical` => `Block`.
- `Major`/`Minor` can merge only with explicit fix plan (task/owner/date).

## 3) Evidence Protocol (Anti-Feeling)

For each applicable rule, record:

- `Status`: `PASS` | `FAIL` | `N/A`
- `Evidence`: `file:line` or exact command output
- `Severity if fail`: `Critical` | `Major` | `Minor`

Rules:

- No evidence = not reviewed.
- `N/A` must include reason.
- Repeated issue: provide one representative location + occurrence count.

### 3.1 Finding Location Format (PR-Friendly)

- Default evidence format: `file:line`.
- For PR-anchored findings, also attach unified diff hunk:
  - `<file>:<line> @@ <unified-diff-hunk>`
  - Example: `src/foo.ts:46 @@ -40 +44,5 @@`
- Generate hunk reference with:
  - `git diff -U0 --no-color <base_sha>..<head_sha> -- <changed-file-path>`
- Report findings only for code that is part of the PR diff.

### 3.2 Historical Anti-Regression Baseline (Mandatory)

Before manual review, derive high-risk focus from previous review history in `logs/`.

Commands:

- `jq -r '.[] | .body | split("\n")[0]' logs/*.txt`
- `jq -r '.[] | .body' logs/*.txt | rg -oi '\[Critical\]|\[Major\]|\[Minor\]|\[Suggestion\]' | tr '[:upper:]' '[:lower:]' | sort | uniq -c | sort -nr`

Minimum checklist from historical recurrence:

1. i18n integrity: no hardcoded UI text, locale key parity, no module-scope `t()` freeze.
2. source-of-truth integrity: no duplicated state ownership (auth token/session/store/API cache).
3. action integrity: no fake controls (`button`, `checkbox`, `draft`, `remember` etc.) without real effect.
4. payload integrity: no silent coercion (`x || undefined`) when empty value carries business meaning.
5. query lifecycle integrity: `enabled` semantics, `isLoading` vs `isFetching`, concurrency and retry safety.
6. regression integrity: changed logic has tests; bugfix has explicit regression test.
7. closure integrity: previously reported issues are truly resolved, not partially addressed.
8. language integrity: Vietnamese-character violations are checked across whole `projects/web-admin` (not only changed files).

## 4) Mandatory Process (P01-P09)

### P01. Scope & Risk Setup

Commands:

- `git diff --name-only main...HEAD`

Actions:

1. List changed files and changed flows.
2. Mark high-risk areas: form/payload, query/store bridge, list-map consistency, i18n, polling, permissions.

### P02. Objective Checks First

Commands:

- Local self-review: `./docs/review-check.sh self-review [base_ref]` (alias: `local`)
- PR review: `./docs/review-check.sh review-pr <PR_NUMBER>` (alias: `pr`)

Action:

1. Save output as objective evidence baseline.
2. If Gate D/F fails, fix immediately where possible before continuing manual review.

### P02b. PR Mode CLI Protocol (Mandatory When Reviewing a PR)

1. Resolve target PR:
- if PR number is unknown: `gh pr list --state open`
- if PR number is known: `gh pr view <PR_NUMBER>`
2. Capture PR metadata:
- `gh pr view <PR_NUMBER> --json number,title,baseRefName,headRefName,baseRefOid,headRefOid,changedFiles,additions,deletions`
3. Capture changed files:
- `gh pr diff <PR_NUMBER> --name-only`
4. Read changed files in full (not only hunks), at PR head snapshot.
5. Read relevant context files:
- imported modules, related tests, and call-sites/usages.
6. Build impact map:
- where changed functions/hooks/selectors are used and what behavior can regress.
7. Then execute P03 -> P09 normally.

### P02c. Historical Recurrence Gate (Mandatory)

Actions:

1. Read previous reviewer comments from `logs/` and mark matched risk clusters for this PR.
2. Promote matched clusters to explicit PASS/FAIL checks in the evidence table.
3. If a cluster appeared as `Still Open`, treat it as high-priority regression hotspot.

### P03. Full-File Reading (Not Only Hunks)

Action for every changed file:

1. Read full file once to validate surrounding context.
2. Verify comments/TODO still match implementation.

Mandatory `.tsx` scans:

- Interactive element behavior match.
- Expensive derivation in render path.
- `.mock` leakage into production UI/hooks.
- Time-based UI using frozen `new Date()`.
- Repeated JSX blocks (3+) needing data-map extraction.
- Form field to payload completeness.

### P04. Semantic Walkthrough (User Perspective)

For each changed flow, execute:

1. `journey`: user steps and expected outcomes.
2. `action contract`: `label -> handler -> side effect -> expected result`.
3. `payload matrix`: each input field maps to request field.
4. `failure matrix`: timeout/4xx/5xx/network/empty/permission and recovery path.

### P05. Source-of-Truth Consistency Check

Required artifacts:

- Source-of-truth map:

| Feature | Source data | Selectors | Surfaces |
| --- | --- | --- | --- |

- One consistency scenario:
  - `filter=<x>, list=<n>, map=<n>, modal=<n>, result=PASS/FAIL`

### P06. Lifecycle & Concurrency Check

Verify:

1. mount -> loading -> success -> refetch -> error -> unmount timeline is coherent.
2. no abrupt dialog/drawer vanish during close/refetch.
3. concurrent actions (double submit, tab switch, re-open) are safe.

### P07. Test & Regression Check

Verify:

1. changed logic has tests in same PR.
2. bugfix has regression test.
3. new branches/edge cases are covered.
4. newly introduced exported selectors/hooks/store-derived helpers have direct tests.

### P08. Decision with Evidence

Output findings by severity with:

- `Issue / Why / Suggested fix / Severity / Evidence`

### P09. Fix-Closure Verification Loop (Mandatory)

When reviewing a follow-up commit after feedback:

1. Build closure table for previous findings: `Fixed` | `Still Open` | `Partially Addressed` | `New Issue`.
2. Re-check each prior finding at exact `file:line` (or moved equivalent) with fresh evidence.
3. Search for side effects from the fix in adjacent logic and call-sites.
4. Do not mark `Fixed` unless behavior is verified end-to-end (not only code moved/refactored).
5. If a fix introduces a new defect, record as `New Issue` with link to triggering change.

## 5) Rule Catalog (Numbered, Short, Executable)

### 5.1 Auto Rules (from `review-check.sh`)

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| AR-01 | Major | No empty `onClick={() => {}}`. | `review-check.sh` Gate A/B |
| AR-02 | Major | No non-null assertion (`!`) in changed source. | Gate C |
| AR-03 | Major | No identity `select: (x) => x` in query hooks. | Gate C |
| AR-04 | Major | Avoid `x \|\| undefined` payload coercion. | Gate A/C |
| AR-05 | Major | No debug console logs in source. | Gate F |
| AR-06 | Major | `enabled` query with `isLoading` must be manually reviewed. | Gate B/C |
| AR-07 | Minor | No duplicate imports from same module in a file. | Gate I |
| AR-08 | Minor | Hardcoded date literal in component requires rationale/TODO. | Gate B/I |
| AR-09 | Major | No mock leakage in components/hooks. | Gate C/D |
| AR-10 | Minor | TS/TSX > 200 lines requires split assessment. | Gate F |
| AR-11 | Critical | Vietnamese chars are blocked by whole-project scan (not diff-only) and must be fixed immediately where possible. | Gate D/F full-scan |
| AR-12 | Critical | Locale key parity with `en.json` must hold. | Gate D Critical |
| AR-13 | Major | Logic changes without tests require explicit plan. | Gate E Major |

### 5.2 Manual Rules — UI & Visual (A)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| A-01 | Major | Use semantic design tokens, avoid random hardcoded colors. | Inspect class/style in changed UI |
| A-02 | Major | Status colors must match domain semantics consistently. | Compare badges/dots/markers/charts |
| A-03 | Minor | Typography must use design-system scales. | Inspect class names/styles |
| A-04 | Minor | Icon usage must be consistent by meaning. | Compare same action across screens |
| A-05 | Major | Chart legends/labels must match actual data mapping. | Walk chart data + legend binding |
| A-06 | Minor | Dynamic SVG IDs must be unique and stable. | Inspect generated id source |

### 5.3 Manual Rules — UX & Interaction (B)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| B-01 | Critical | Every interactive element has real effect. | Scan clickable controls + run flow |
| B-02 | Critical | Label/action semantics must match. | Build action contract table |
| B-03 | Major | Dialog/Drawer pattern follows project convention. | Compare with `dialog_and_form_pattern.md` |
| B-04 | Major | Cancel/Close path uses correct close primitive. | Inspect close handler + unmount behavior |
| B-05 | Major | No premature `return null` that breaks close animation. | Check dialog body guards + close timeline |
| B-06 | Critical | Every user input is represented in submit payload or explicit TODO dependency. | Build payload matrix |
| B-07 | Major | Form reset uses explicit default object. | Inspect reset paths |
| B-08 | Major | Validation covers business edge cases. | Review schema + edge scenarios |
| B-09 | Major | Success/error feedback is actionable. | Simulate success + failure |
| B-10 | Critical | Multi-surface dataset (list/map/modal/chart) uses same filtered source. | Source-of-truth map + count scenario |
| B-11 | Major | Pagination `hasMore` depends on server counts/contracts. | Check totalCount/nextCursor handling |
| B-12 | Major | Optimistic updates have persistence and rollback plan. | Inspect mutation handlers |
| B-13 | Major | Reservation/scheduled flows use user-selected time, not incidental trigger time. | Compare field value -> request field |

### 5.4 Manual Rules — API & Data Integrity (C)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| C-01 | Critical | Request/response mapping preserves meaning and units. | Trace DTO -> UI -> payload |
| C-02 | Major | Query keys include all semantic params. | Inspect hook key factories |
| C-03 | Major | Keyword queries use safe `enabled` guard. | Inspect query options |
| C-04 | Major | List queries include explicit `limit` or rationale. | Inspect request params |
| C-05 | Major | No identity `select` wrappers/no-op transforms. | Inspect query options |
| C-06 | Critical | Empty string vs omitted field intent is preserved. | Compare UI clear state -> payload |
| C-07 | Major | Numeric transforms are validated before submit. | Review parsing/refine checks |
| C-08 | Major | Error handling does not swallow debugging context in logs/telemetry. | Inspect `onError` behavior |
| C-09 | Major | API-side TODOs must state endpoint and migration path. | Check TODO format and location |
| C-10 | Major | No `.mock.ts` dependency leaks into production hooks/UI. | Full-file scan imports |

### 5.5 Manual Rules — Logic & Edge Cases (D)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| D-01 | Critical | Branches/fallbacks cover all valid states. | Walk state matrix |
| D-02 | Major | No always-true/always-false/redundant checks. | Read condition logic fully |
| D-03 | Major | No dead branch or unreachable default kept silently. | Trace branch reachability |
| D-04 | Major | Repeated lookup on same dataset is centralized/memoized. | Find repeated `find/filter` |
| D-05 | Critical | Lifecycle order is coherent under refetch/unmount. | Timeline walkthrough |
| D-06 | Major | Refetch does not cause stale or inconsistent cross-component state. | Query/store bridge check |
| D-07 | Major | Concurrency path handles double submit / rapid toggle safely. | Simulate user race actions |
| D-08 | Major | Placeholder data in production UI has explicit TODO source. | Detect hardcoded business values |
| D-09 | Major | Polling/refetch error must not blank the whole screen when last known good data exists. | Simulate error with cached data |

### 5.6 Manual Rules — Performance & Re-render (E)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| E-01 | Major | Expensive derivations in render path are memoized. | Inspect `.map/filter/find/sort` usage |
| E-02 | Major | O(n×m) loops are replaced by precomputed map/set when needed. | Complexity scan by hot paths |
| E-03 | Major | Timer-driven state is isolated to smallest subtree. | Inspect timer placement |
| E-04 | Major | Polling frequency changes include impact review. | Compare intervals + affected components |
| E-05 | Minor | Avoid ineffective memoization due to unstable object refs. | Inspect memo inputs and prop identity |
| E-06 | Major | Avoid duplicate network polling for derivable summary data. | Compare hooks and store selectors |
| E-07 | Major | Large list rendering has virtualization/pagination rationale. | Check rendering strategy |

### 5.7 Manual Rules — Architecture & Structure (F)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| F-01 | Major | Folder and file structure follows project conventions. | Compare with docs patterns |
| F-02 | Major | Public exports are controlled, no accidental leakage. | Inspect `index.ts` and imports |
| F-03 | Major | Store has `initialState`, `actions`, `reset`, selectors consistency. | Inspect store module |
| F-04 | Major | Repeated mapping logic is centralized. | Search duplicate switch/map blocks |
| F-05 | Minor | Oversized files are split by responsibility boundaries. | Review >200 lines modules |

### 5.8 Manual Rules — Testing (G)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| G-01 | Critical | New/changed logic has tests in same PR. | Cross-check changed logic files vs tests |
| G-02 | Critical | Bugfix includes regression test. | Verify bug case assertion |
| G-03 | Major | New branch paths and edge cases are covered. | Inspect test cases matrix |
| G-04 | Major | Async/retry/error flows have at least one test path. | Check hook/store tests |
| G-05 | Major | Test data matches real contract shape. | Compare DTO fixtures |
| G-06 | Critical | Each newly exported selector/hook in changed store file has at least one direct test. | Map new exports -> test references |

### 5.9 Manual Rules — i18n (H)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| H-01 | Critical | No hardcoded UI text in components. | Search JSX text + verify intent |
| H-02 | Critical | Locale keys are synced across all locales. | Locale parity check |
| H-03 | Major | Validation messages use i18n keys. | Inspect schema messages |
| H-04 | Major | Module-scope `t()` usage must be justified and stable. | Inspect comments + lifecycle risk |
| H-05 | Major | Interpolation is used for quantities/units/time. | Check translated strings |
| H-06 | Critical | Non-English code comments are not allowed. | Manual check + script warning |

### 5.10 Manual Rules — Naming & Hygiene (I)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| I-01 | Minor | No unused imports/decls/exports after change. | lint + manual scan |
| I-02 | Major | Comments/TODO describe real next step, not stale context. | Full-file read |
| I-03 | Major | Placeholder/future code has owner or dependency note. | Check TODO format |
| I-04 | Minor | Import order/grouping remains clean. | lint + file scan |
| I-05 | Major | No no-op wrappers or dead adapters left behind. | inspect helper functions |

### 5.11 Manual Rules — Docs Compliance (J)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| J-01 | Major | Changed code complies with applicable docs patterns. | Map change -> doc(s) |
| J-02 | Major | UI controls introduced in PR have implemented effect. | UX walkthrough |
| J-03 | Major | Domain enum/state mapping is centralized and documented. | compare across files |

### 5.12 Manual Rules — Accessibility (K)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| K-01 | Major | Keyboard navigation and focus order are valid. | Keyboard walkthrough |
| K-02 | Major | Non-text controls have accessible labels. | Inspect `aria-label`/name |
| K-03 | Major | Disabled/loading/error states are semantically exposed. | Inspect attributes + text |
| K-04 | Major | Color contrast is acceptable across states. | Visual check + token review |

### 5.13 Manual Rules — Security, Privacy, Observability (L)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| L-01 | Critical | No sensitive data in logs/toasts/errors. | scan error handlers/messages |
| L-02 | Critical | Sensitive actions have permission guard. | inspect route/action guards |
| L-03 | Major | User input is validated and normalized. | inspect schema + transforms |
| L-04 | Major | User-facing errors hide internal details. | inspect toast/error messages |
| L-05 | Major | Critical flows emit minimum telemetry/tracing events. | inspect logging/analytics hooks |

### 5.14 Manual Rules — Historical Recurrence Prevention (M)

| ID | Severity | Rule | How to execute |
| --- | --- | --- | --- |
| M-01 | Critical | UI controls must have real behavior (no no-op draft/save/search/toggle actions). | click-path walkthrough + handler trace |
| M-02 | Critical | Auth/session state uses one clear source of truth; no dual token ownership. | trace login/refresh/logout/interceptor lifecycle |
| M-03 | Major | No module-scope i18n evaluation that freezes runtime language switching. | inspect schema/options/constants using `t()` |
| M-04 | Critical | Locale structures match `en.json` hierarchy and keys exactly. | locale parity + nested structure diff |
| M-05 | Major | Dialog/Drawer close lifecycle remains mounted for animation and safe refetch. | inspect guards + close timeline |
| M-06 | Major | Query disabled/loading states are semantically correct (`isFetching`/`enabled`/retry). | inspect query options + empty-search flow |
| M-07 | Critical | Update payload preserves intentional empty values; no truthy-coercion data loss. | inspect update request mapping |
| M-08 | Major | Shared DTO/types are reused from source; no duplicate local type shadows. | inspect type imports/definitions |
| M-09 | Major | Non-null assertions in submit/mutation paths are replaced by safe guards. | inspect submit handlers and guards |
| M-10 | Major | Hardcoded business/mock values are isolated in `.mock.ts` or TODO with owner/date. | scan constants + TODO metadata |
| M-11 | Major | Any logic fix must include regression test aligned with prior finding. | map finding -> test case evidence |
| M-12 | Major | Follow-up reviews must include closure status for previous findings. | verify closure table in review output |

## 6) High-Value Manual Probes (Semantic/Design/Perf)

Apply these probes on every high-risk flow:

1. `Probe-SOT`: one source-of-truth dataset across all surfaces.
2. `Probe-Contract`: label -> handler -> payload -> server effect.
3. `Probe-EmptyVsOmitted`: explicit clear value is not silently dropped.
4. `Probe-Lifecycle`: close/refetch/unmount does not break UX continuity.
5. `Probe-Consistency`: same filter gives same count in list/map/modal.
6. `Probe-ErrorRecovery`: error state has retry/back/close/support path.
7. `Probe-PerfHotPath`: remove repeated linear scans in render hot path.
8. `Probe-PollingImpact`: avoid duplicate polling for derivable data.
9. `Probe-Scheduling`: scheduled datetime comes from user input, not side-effect timing.
10. `Probe-Regression`: every fixed bug has executable regression check.
11. `Probe-StaleOnError`: on polling error with existing data, UI degrades gracefully (not blank screen).
12. `Probe-ActionReality`: every visible action has observable effect and correct naming.
13. `Probe-I18nRuntime`: switch locale at runtime; labels and validation messages update correctly.
14. `Probe-FixClosure`: previously reported defects are either fully fixed or explicitly still open.
15. `Probe-DataOwnership`: verify one owner per critical state (token/session/selection/filter source).

## 7) Minimum Review Output (DoD)

Every review must end with:

1. findings by severity (`Critical/Major/Minor`).
2. accepted risks with rationale.
3. scope confirmation (flows + sections reviewed).
4. evidence table with representative high-risk checks.
5. closure table for previous findings when this is a follow-up review.

Constraints for review output:

- Every finding must be actionable and tied to concrete location evidence.
- Suggestions must be applicable to the changed code path in this PR.
- Do not add non-actionable sections unrelated to code quality (for example deployment/operations notes).

Notes:

- Objective checks are baseline only; semantic/design/perf findings must come from manual probes and full-file reading.

Template:

```md
## Review Summary

### Scope
- PR mode: Full (mandatory)
- Flows reviewed: <list>
- Rule groups reviewed: <Auto, A-M>

### Findings
- Critical: <count>
- Major: <count>
- Minor: <count>

### Evidence (sample)
| Item | Status | Evidence | Severity if fail |
| --- | --- | --- | --- |
| B-06 Form payload completeness | PASS | src/...:120 | Critical |
| H-01 Hardcoded UI text | FAIL | rg ... output | Critical |
| G-02 Bugfix regression test | PASS | src/...test.ts:42 | Critical |

### Previous Findings Closure (follow-up reviews only)
| Previous finding | Closure status | Evidence |
| --- | --- | --- |
| PR-xx #1 Auth token dual source | Fixed | src/...:45 |
| PR-xx #2 Missing tests | Still Open | (no new test file) |

### Merge Decision
- Decision: Merge | Block
- Remaining risks: <none/details>
```

## 8) Self-Review Runbook (Mandatory)

1. `git diff --name-only main...HEAD`
2. `./docs/review-check.sh self-review [base_ref]` (alias: `local`)
3. `jq -r '.[] | .body | split("\n")[0]' logs/*.txt` and mark relevant recurrence clusters.
4. Complete process `P01 -> P09`.
5. `pnpm run lint`
6. Publish review summary with evidence (+ closure table for follow-up).
7. If Gate D/F fails, stop, fix Vietnamese-character findings, and rerun until clean.

If any unresolved `Critical` remains, stop and fix before merge.
