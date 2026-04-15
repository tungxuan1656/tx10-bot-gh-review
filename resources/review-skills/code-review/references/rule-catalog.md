# Rule Catalog

Apply these rules to changed code and the directly affected context. Report only evidence-backed failures.

## Core Review Rules

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| CORE-01 | Critical | Every finding must include concrete evidence. | `file:line` or command output |
| CORE-02 | Major | Read full changed files before commenting. | Full-file inspection |
| CORE-03 | Major | Review changed logic, not only syntax or style. | Semantic walkthrough |
| CORE-04 | Major | Repeated issues must list every affected location, not just one representative instance. | Full-location listing |
| CORE-05 | Critical | Follow-up reviews must verify closure of prior findings. | Closure table plus fresh evidence |

## Correctness and Behavior

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| B-01 | Critical | Every interactive or callable action has a real effect. | Trace control or call path end to end |
| B-02 | Critical | Label, intent, and actual effect match. | Action contract |
| B-03 | Critical | Every required user input or state field is represented in the payload or explicitly omitted by rule. | Payload matrix |
| B-04 | Major | Edge cases and failure states are handled coherently. | Failure matrix |
| B-05 | Major | No always-true, always-false, or redundant branch logic. | Branch inspection |
| B-06 | Major | Success, error, and retry states are actionable and clear. | Walk the state transitions |
| B-07 | Major | Placeholder, fake, or draft behavior is not presented as real functionality. | Handler trace plus UI or call-path review |
| B-08 | Major | Async calls that are intentionally fire-and-forget are marked with `void`. Unintentional unawaited promises are not present. | Async call-site scan |
| B-09 | Minor | Functions with a declared or expected return type do not fall off the end with an implicit `undefined`. | Return-path inspection |

## Security and Privacy

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| S-01 | Critical | Sensitive actions have authentication and authorization guards. | Route, handler, or mutation guard trace |
| S-02 | Critical | No hardcoded secrets or credentials appear in source. | File scan |
| S-03 | Critical | User-controlled input is not executed, interpolated unsafely, or used in dangerous paths without validation. | Input-to-sink trace |
| S-04 | Critical | Sensitive data is not exposed in logs, toasts, errors, or telemetry. | Error and logging scan |
| S-05 | Major | User-facing errors hide internal details. | Error-message inspection |
| S-06 | Major | External calls, uploads, or sensitive writes validate and normalize input. | Schema and transform inspection |

## Data Integrity and Contracts

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| D-01 | Critical | Request and response mappings preserve meaning, units, and empty values. | DTO and payload trace |
| D-02 | Critical | Intentional empty values are not silently coerced away. | Empty-vs-omitted probe |
| D-03 | Critical | Critical state has one clear source of truth. | State ownership map |
| D-04 | Major | Query keys and cache semantics include all meaningful parameters. | Hook and key inspection |
| D-05 | Major | Shared DTOs, schemas, and types are reused instead of shadowed locally. | Type and import inspection |
| D-06 | Major | Numeric, date, and enum transforms are validated before use or submit. | Transformation trace |
| D-07 | Minor | Magic numbers and strings used in logic or configuration are extracted to named constants, not left as inline literals. | Literal scan |

## Lifecycle and Concurrency

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| L-01 | Critical | Mount, loading, success, refetch, error, close, and unmount remain coherent. | Lifecycle walkthrough |
| L-02 | Major | Double submit, rapid toggle, reopen, and retry do not create inconsistent state. | Concurrency probe |
| L-03 | Major | Dialogs, drawers, and transient surfaces do not disappear prematurely during close or refetch. *(Frontend only.)* | Close and refetch timeline |
| L-04 | Major | Polling and retries do not blank the UI when last known good data exists. *(Frontend only.)* | Error-with-cached-data inspection |
| L-05 | Major | Non-null assertions or unsafe assumptions are not used in submit or mutation paths without guards. | Guard inspection |
| L-06 | Major | Every timer, interval, event listener, stream, or file handle opened in changed code has a corresponding cleanup or close path. | Resource open/close pair inspection |

## Performance

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| P-01 | Major | Expensive derivations are not repeated in hot render or request paths without reason. | Hot-path scan |
| P-02 | Major | Obvious O(n*m) work is replaced by indexed lookup when the path is performance-sensitive. | Complexity scan |
| P-03 | Major | Large list rendering has pagination, virtualization, or clear rationale. | Rendering strategy review |
| P-04 | Major | Polling frequency and duplicate fetch behavior have been considered. | Request behavior inspection |
| P-05 | Minor | Memoization is not ineffective due to unstable identities. | Dependency and identity scan |

## Architecture and Maintainability

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| A-01 | Major | Code follows the repository's responsibility boundaries and naming conventions. | File and module inspection |
| A-02 | Major | Repeated mapping, branching, or adapter logic is centralized when duplication creates risk. | Duplication scan |
| A-03 | Major | Comments and TODOs still describe real behavior and a real next step. | Full-file reading |
| A-04 | Major | Public exports are intentional and not accidental leakage. | Export surface inspection |
| A-05 | Minor | Oversized files or functions are split when they materially reduce reviewability or future risk. | Responsibility scan |

## Tests and Regression

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| T-01 | Critical | New or changed logic has tests in the same review scope. | Diff-to-test cross-check |
| T-02 | Critical | Bug fixes include a regression test. | Bug-case assertion review |
| T-03 | Major | Edge cases, async paths, retries, and failures have meaningful coverage. | Test matrix inspection |
| T-04 | Major | Test fixtures reflect real contract shapes. | Fixture-to-contract comparison |
| T-05 | Major | New exported selectors, helpers, hooks, or adapters have direct tests when they own logic. | Export-to-test mapping |

## Type Safety

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| TS-01 | Major | `as` type casts in non-trivial paths are justified by a visible guard or comment; unsafe casts to a concrete type without narrowing are flagged. | Cast inspection |
| TS-02 | Major | `any` types introduced by the change are intentional; prefer `unknown` with explicit narrowing. | Type annotation scan |
| TS-03 | Minor | Non-null assertions (`!`) are not used where optional chaining (`?.`) or an explicit guard is available and sufficient. | Non-null assertion scan |
| TS-04 | Minor | Overly broad types (`object`, `Record<string, unknown>`) are not used where a specific type exists and is reachable. | Type breadth inspection |

## i18n and Accessibility

> **Scope:** Apply these rules to frontend changes only. Skip for backend services, APIs, or any code that produces no user-facing UI output.

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| I-01 | Critical | No hardcoded user-facing UI text is introduced where localization is expected. | UI text scan |
| I-02 | Critical | Locale key structures remain aligned across locales. | Locale parity check |
| I-03 | Major | Validation and runtime messages use localization patterns consistently. | Message source inspection |
| I-04 | Major | Runtime locale switching is not frozen by module-scope evaluation. | i18n lifecycle review |
| I-05 | Major | Keyboard access, accessible names, and state semantics remain valid for changed controls. | Accessibility walkthrough |

## Documentation and Hygiene

| ID | Severity | Rule | How to verify |
| --- | --- | --- | --- |
| H-01 | Minor | No unused imports, declarations, or dead wrappers are introduced. | Lint plus file scan |
| H-02 | Major | Documentation updates exist when public behavior or contract changed materially. | Diff-to-doc cross-check |
| H-03 | Major | Temporary code, placeholders, or future paths include an owner, dependency, or follow-up note. | TODO review |
| H-04 | Minor | Import grouping and file hygiene remain clean after the change. | File scan |
| H-05 | Minor | The PR title and description match the actual scope of changes. Flag significant divergence between stated intent and the diff. | Diff-to-description comparison |
