# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project Direction

This repository is a root-level Node.js + TypeScript service for an AI-powered GitHub review bot.

The MVP acts as a GitHub App that:

- receives GitHub webhooks
- fetches pull request diffs and head file contents
- sends constrained review prompts to Codex CLI
- publishes inline comments plus an overall GitHub review decision

## Architecture

### HTTP layer

- lives in `src/http`
- exposes `POST /github/webhooks`
- exposes `GET /healthz`
- verifies GitHub webhook signatures before dispatching review work

### Review engine

- lives in `src/review`
- filters reviewable files from the PR diff
- builds the Codex prompt from patch + current file content
- validates Codex output against a strict JSON schema
- maps findings deterministically to `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`

### Documentation and validation

- `docs/` contains architecture, review contract, and runbook docs
- `test/` contains unit and integration tests for the MVP seams
- CI must keep code, tests, and docs aligned in the same change set

## Identity and Decision Rules

- GitHub App auth is the only supported auth path for MVP flows
- Review output is trusted only after schema validation
- Final GitHub review state is derived from findings severity, not from free-form model wording
- Idempotency is enforced per `(repo, pull request number, head SHA)`
- Invalid inline comment targets must fall back to the top-level review body, not fail the whole review

## Scope Rules

1. This repo is a single runnable root service, not a pnpm monorepo.
2. New MVP behavior should extend the existing root app instead of inventing extra packages or services.
3. The bot reviews code only; it must not execute untrusted PR code.
4. GitHub interactions should use GitHub App credentials, not personal access token fallbacks.
5. Codex integration should prefer deterministic machine-readable contracts over regex or free-text parsing.
6. Docs, tests, and behavior changes must stay aligned in the same change set.

## Project Rules

1. Keep the service stateless for MVP unless the task explicitly introduces durable state.
2. Prefer small, explicit modules under `src/http` and `src/review` over premature abstraction.
3. Keep supported file filtering and review-decision logic deterministic and test-covered.
4. On transient failures, prefer a neutral PR comment over an incorrect approval or blocking review.
5. Do not broaden supported languages, config systems, or deployment topology unless requested.
6. Preserve the current documentation structure in `README.md` and `docs/` when updating behavior.

## Repository Layout Guidance

- keep the runnable app at the repo root
- keep webhook/server concerns in `src/http`
- keep review, prompt, Codex, and GitHub publishing logic in `src/review`
- add scripts under `scripts/` only when they support local development, validation, or docs
