# Architecture

## System Overview

```mermaid
flowchart LR
  GitHub[GitHub Pull Request Event] --> Webhook[Express Webhook Server]
  Webhook --> Service[Review Service]
  Service --> GitHubAPI[GitHub App API Client]
  Service --> Codex[Codex CLI]
  GitHubAPI --> GitHub
```

## Core Components

- **Webhook server** verifies `x-hub-signature-256`, accepts supported `pull_request` actions, and dispatches asynchronous review work.
- **Review service** enforces supported actions, filters files, builds prompts, invokes Codex, applies deterministic decision logic, and publishes results.
- **GitHub review platform** authenticates as a GitHub App installation, fetches changed files and head content, checks idempotency markers, and submits reviews or fallback comments.
- **Codex runner** shells out to `codex exec` with a JSON Schema file so the final response is machine-validated before any GitHub action is taken.

## Sequence Diagram

```mermaid
sequenceDiagram
  participant Dev
  participant GitHub
  participant Bot
  participant Codex

  Dev->>GitHub: Open PR / push commit
  GitHub->>Bot: pull_request webhook
  Bot->>Bot: Verify signature and route supported action
  Bot->>GitHub: Fetch PR files and head content
  Bot->>Codex: Submit filtered diff + file content prompt
  Codex-->>Bot: Structured JSON review result
  Bot->>Bot: Map findings to COMMENT / REQUEST_CHANGES / APPROVE
  Bot->>GitHub: Submit review or fallback comment
```

## MVP Design Decisions

- The service is a single root TypeScript app instead of a monorepo split.
- Webhook handling is asynchronous after signature verification so GitHub receives a fast `202 Accepted`.
- Codex output is trusted only after JSON Schema validation.
- Idempotency uses a marker tied to `(repo, pull request, head SHA)` and checks both prior reviews and issue comments.
- Invalid inline comment targets are moved into the top-level review body instead of failing the entire review.

## Boundaries

- The bot does not execute code from the pull request.
- The bot only reviews files that match the configured language filter and have patch hunks GitHub can comment on.
- Background queues, repo-level config, and observability dashboards are explicitly out of scope for the MVP.
