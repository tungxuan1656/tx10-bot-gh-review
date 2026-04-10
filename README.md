# AI Code Review Bot

AI Code Review Bot is a machine-user GitHub reviewer powered by Codex CLI. It receives repository or organization pull request webhooks, waits until the configured bot account is explicitly requested as a reviewer, then builds a constrained AI review request from the diff plus current file contents and publishes one GitHub review per head SHA.

## MVP Scope

- Repository or organization webhook ingestion
- Diff filtering for `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, and `.java`
- Codex CLI invocation with a strict JSON output contract
- Deterministic GitHub review publishing:
- `REQUEST_CHANGES` for `critical` or `high`
- `COMMENT` for `medium`, `low`, or `info`
- `APPROVE` when there are no findings
- Review only when the configured bot account is requested via `review_requested`

## Project Layout

- `src/http` contains the Express server, `/github/webhooks`, and `/healthz`
- `src/review` contains file filtering, prompt assembly, Codex invocation, decision logic, and GitHub publishing
- `docs` contains architecture, prompt contract, and operational runbooks
- `test` contains unit and integration coverage for the MVP seams

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | Fine-grained PAT or classic PAT for the machine user |
| `GITHUB_BOT_LOGIN` | Yes | Exact GitHub login of the machine user reviewer |
| `GITHUB_WEBHOOK_SECRET` | Yes | Shared secret used to verify repository or organization webhooks |
| `CODEX_BIN` | No | Codex CLI binary path. Defaults to `codex`. |
| `LOG_LEVEL` | No | Pino log level. Defaults to `info`. |
| `LOG_PRETTY` | No | Pretty-print logs (`auto`, `true`, or `false`). Defaults to `auto` (enabled in development TTY). |
| `PORT` | No | HTTP port. Defaults to `43191`. |

## Local Development

1. Install dependencies with `pnpm install`.
2. Export the required environment variables.
3. Start the server with `pnpm dev`.
4. Expose the local webhook endpoint with a tunnel such as `ngrok`:
   - `POST /github/webhooks`
   - `GET /healthz`

## GitHub Setup

1. Create a dedicated GitHub account that will act as the reviewer bot.
2. Add that account to the target repository or organization with enough access to read pull requests and submit reviews.
3. Generate a token for that account and export it as `GITHUB_TOKEN`.
4. Configure a repository or organization webhook that points at `/github/webhooks`.
5. Set the webhook secret to the same value used in `GITHUB_WEBHOOK_SECRET`.
6. Make sure pull request events are enabled in the webhook configuration.

## Validation

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm docs:lint`
- `pnpm docs:check-links`
- `pnpm validate`

## Deployment

The repo ships with a supported single-process `Dockerfile` that installs Codex CLI and exposes the default app port `43191`, but the recommended first production setup is still a small Linux server running the app with `systemd` behind `nginx`. If you use the container image, you still need to provide Codex authentication inside the container. The service is intentionally stateless; idempotency is enforced by checking for an existing marker on the current PR head SHA before publishing a new result after the bot account is requested for review.

## Further Reading

- [Architecture](docs/architecture.md)
- [Deployment Guide](docs/deployment.md)
- [macOS + PM2 + Cloudflare Tunnel Guide](docs/deployment-macos.md)
- [Review Contract](docs/review-contract.md)
- [Runbook](docs/runbook.md)
