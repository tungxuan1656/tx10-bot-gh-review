# Architecture

## System Overview

```mermaid
flowchart LR
  GitHub[GitHub Pull Request Event] --> Webhook[Express Webhook Server]
  Webhook --> Service[Review Service]
  Service --> GitHubAPI[Machine User API Client]
  Service --> Workspace[Temporary Git Workspace]
  Workspace --> Codex[Codex CLI]
  GitHubAPI --> GitHub
```

## Core Components

- **Webhook server** verifies `x-hub-signature-256`, normalizes `pull_request` webhook metadata, emits structured lifecycle logs, and dispatches asynchronous review work.
- **Review service** routes every normalized `pull_request` action to one of three outcomes: `trigger_review`, `ignored`, or `cancel_requested`. It enqueues all work into a single in-process global FIFO queue shared across repositories, triggers reviews for `review_requested` (bot requested) and `synchronize` (bot still requested), and supports best-effort cancellation.
- **GitHub review platform** authenticates with the machine-user token, checks idempotency markers, and submits reviews or fallback comments.
- **Temporary workspace manager** creates an isolated git directory, fetches the exact `baseSha` and `headSha`, checks out the PR head, copies `resources/review-skills/*` into `.agents/skills`, and prepares deterministic refs (`refs/codex-review/base` and `refs/codex-review/head`) for in-workspace git inspection.
- **Codex runner** shells out to `codex exec --cd <workspace> --sandbox workspace-write` with a JSON Schema file so the final response is machine-validated before any GitHub action is taken, and supports hard process cancellation for preempted runs.

## Sequence Diagram

```mermaid
sequenceDiagram
  participant Dev
  participant GitHub
  participant Bot
  participant Codex

  Dev->>GitHub: Request review from bot account
  GitHub->>Bot: pull_request webhook
  Bot->>Bot: Verify signature and normalize delivery metadata
  Bot->>Bot: Route action to trigger_review / ignored / cancel_requested
  Bot->>Bot: Prepare temporary git workspace for base/head SHAs
  Bot->>Bot: Copy bundled review skills into temp workspace
  Bot->>Codex: Submit repo-first prompt (Codex reads git diff and files in workspace)
  Codex-->>Bot: Structured JSON review result
  Bot->>Bot: Validate decision against findings and map to REQUEST_CHANGES / APPROVE
  Bot->>GitHub: Submit review or fallback comment
```

## MVP Design Decisions

- The service is a single root TypeScript app instead of a monorepo split.
- Webhook handling is asynchronous after signature verification so GitHub receives a fast `202 Accepted`.
- Review execution is queue-driven: all review requests are serialized through one global FIFO worker.
- `synchronize` events trigger a re-review only when the bot remains in `pull_request.requested_reviewers`.
- If a newer commit arrives for the same PR while a run is active, the run is preempted and the active Codex process is canceled.
- Each run fetches PR discussion history from GitHub (GraphQL-first with REST fallback), stores it as `pr-review-comments.md`, and prompts Codex to read it from workspace.
- `review_request_removed` requests a best-effort in-memory cancellation for the active run and removes queued work for that PR.
- Approved lock can skip subsequent commits on a PR after a bot `APPROVE` when enabled.
- Codex output is trusted only after JSON Schema validation.
- Idempotency uses a marker tied to `(repo, pull request, head SHA)` and checks both prior reviews and issue comments.
- Invalid inline comment targets are moved into the top-level review body instead of failing the entire review.

## Boundaries

- The bot does not execute code from the pull request.
- The bot only reviews files that match the configured language filter and have patch hunks GitHub can comment on.
- Distributed queues, durable state recovery after process restart, and observability dashboards are explicitly out of scope for the MVP.
