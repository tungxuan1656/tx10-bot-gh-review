# AI Code Review Bot

AI Code Review Bot is a GitHub App powered by Codex CLI. It receives pull request webhooks, builds a constrained AI review request from the diff plus current file contents, and publishes one GitHub review per head SHA with inline comments and an overall verdict.

## MVP Scope

- GitHub App webhook ingestion
- Diff filtering for `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, and `.java`
- Codex CLI invocation with a strict JSON output contract
- Deterministic GitHub review publishing:
  - `REQUEST_CHANGES` for `critical` or `high`
  - `COMMENT` for `medium`, `low`, or `info`
  - `APPROVE` when there are no findings
- Re-review on new pull request commits

## Project Layout

- `src/http` contains the Express server, `/github/webhooks`, and `/healthz`
- `src/review` contains file filtering, prompt assembly, Codex invocation, decision logic, and GitHub publishing
- `docs` contains architecture, prompt contract, and operational runbooks
- `test` contains unit and integration coverage for the MVP seams

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | GitHub App private key PEM. Escaped `\n` is supported. |
| `GITHUB_WEBHOOK_SECRET` | Yes | Shared secret used to verify webhook signatures |
| `GITHUB_INSTALLATION_ID` | No | Override installation resolution when a fixed installation is required |
| `CODEX_BIN` | No | Codex CLI binary path. Defaults to `codex`. |
| `LOG_LEVEL` | No | Pino log level. Defaults to `info`. |
| `PORT` | No | HTTP port. Defaults to `43191`. |

## Local Development

1. Install dependencies with `pnpm install`.
2. Export the required environment variables.
3. Start the server with `pnpm dev`.
4. Expose the local webhook endpoint with a tunnel such as `ngrok`:
   - `POST /github/webhooks`
   - `GET /healthz`

## GitHub App Setup

1. Create a GitHub App.
2. Configure the webhook URL to point at `/github/webhooks`.
3. Set the webhook secret to the same value used in `GITHUB_WEBHOOK_SECRET`.
4. Grant pull request and issues write permissions so the bot can submit reviews and fallback comments.
5. Install the app on the target repository.

## Validation

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm docs:lint`
- `pnpm docs:check-links`
- `pnpm validate`

## Deployment

The repo ships with a supported single-process `Dockerfile` that installs Codex CLI and exposes the default app port `43191`, but the recommended first production setup is still a small Linux server running the app with `systemd` behind `nginx`. If you use the container image, you still need to provide Codex authentication inside the container. The service is intentionally stateless; idempotency is enforced by checking for an existing marker on the current PR head SHA before publishing a new result.

## Further Reading

- [Architecture](docs/architecture.md)
- [Deployment Guide](docs/deployment.md)
- [macOS + PM2 + Cloudflare Tunnel Guide](docs/deployment-macos.md)
- [Review Contract](docs/review-contract.md)
- [Runbook](docs/runbook.md)
