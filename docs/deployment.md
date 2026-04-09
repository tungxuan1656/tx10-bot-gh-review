# Deployment Guide

This guide walks through a production-style setup for the GitHub review bot on a small Linux server. It covers:

- provisioning the server
- installing Node.js and pnpm
- installing and authenticating Codex CLI
- running the app with `systemd`
- exposing the webhook with `nginx` and HTTPS
- configuring the GitHub App webhook

## Recommended Topology

Use this layout for the first deployment:

- Ubuntu 22.04 or 24.04 server
- one non-root deploy user
- Node.js 22
- pnpm via `corepack`
- Codex CLI installed globally on the server
- app process managed by `systemd`
- `nginx` terminating TLS and proxying to `localhost:43191`

This is the recommended path over Docker for the first setup because Codex CLI authentication and local credential storage are simpler to manage directly on the host.

## Prerequisites

Before starting, make sure you have:

- a public domain such as `bot.example.com`
- a Linux server with outbound internet access
- an OpenAI account that can use Codex CLI
- a GitHub account that can create and install a GitHub App
- this repository available on the server

## 1. Prepare the Server

Run these commands on a fresh Ubuntu server:

```bash
sudo apt update
sudo apt install -y curl git nginx build-essential
```

Install Node.js 22 and enable pnpm through `corepack`:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@10.28.1 --activate
node -v
pnpm -v
```

Create a dedicated deploy user if you do not already have one:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG sudo deploy
```

## 2. Clone and Build the App

Switch to the deploy user:

```bash
sudo -iu deploy
```

Clone the repository and install dependencies:

```bash
git clone <YOUR_REPO_URL> ~/tx10-bot-gh-review
cd ~/tx10-bot-gh-review
pnpm install --frozen-lockfile
pnpm build
```

Optional but recommended before the first production run:

```bash
pnpm validate
```

## 3. Install Codex CLI

Install Codex CLI globally for the deploy user:

```bash
npm install -g @openai/codex
codex --version
```

At the time this guide was written, a working install can be checked with:

```bash
codex --version
codex login status
```

## 4. Authenticate Codex CLI

Choose one of the following authentication methods.

### Option A: Sign in with ChatGPT

This is the easiest interactive setup when you have a browser available:

```bash
codex --login
```

Complete the sign-in flow and confirm the session:

```bash
codex login status
```

### Option B: Log in with an API Key

This is often easier for headless servers:

```bash
export OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

If `codex login status` does not show a valid login, stop here and fix authentication before continuing. The bot cannot review PRs without a working Codex CLI session.

## 5. Create the Runtime Environment File

Create an environment file for the service:

```bash
cat > ~/tx10-bot-gh-review/.env <<'EOF'
PORT=43191
LOG_LEVEL=info
CODEX_BIN=codex
GITHUB_APP_ID=1234567
GITHUB_WEBHOOK_SECRET=replace-with-random-secret
GITHUB_INSTALLATION_ID=
GITHUB_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----\n'
EOF
```

Notes:

- `GITHUB_INSTALLATION_ID` is optional. Leave it blank unless you intentionally want to force a single installation.
- `GITHUB_PRIVATE_KEY` must be stored as one line with literal `\n` characters.
- Use the private key downloaded from the GitHub App settings page.

One safe way to convert the private key file into the required one-line format is:

```bash
python3 - <<'PY'
from pathlib import Path
key = Path("github-app.private-key.pem").read_text().strip()
print(key.replace("\n", "\\n"))
PY
```

Then paste that output between the single quotes for `GITHUB_PRIVATE_KEY`.

Lock down the file:

```bash
chmod 600 ~/tx10-bot-gh-review/.env
```

## 6. Smoke Test the App Locally on the Server

Before adding `systemd`, verify that the app can start:

```bash
cd ~/tx10-bot-gh-review
set -a
source .env
set +a
node dist/http/index.js
```

In a second shell, check:

```bash
curl http://127.0.0.1:43191/healthz
```

Expected response:

```json
{"status":"ok"}
```

Stop the process after this check.

## 7. Create a systemd Service

Create `/etc/systemd/system/gh-review-bot.service`:

```ini
[Unit]
Description=GitHub Review Bot
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/tx10-bot-gh-review
EnvironmentFile=/home/deploy/tx10-bot-gh-review/.env
ExecStart=/usr/bin/node /home/deploy/tx10-bot-gh-review/dist/http/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gh-review-bot
sudo systemctl status gh-review-bot
```

Useful logs:

```bash
sudo journalctl -u gh-review-bot -f
```

## 8. Configure nginx and HTTPS

Create `/etc/nginx/sites-available/gh-review-bot`:

```nginx
server {
    listen 80;
    server_name bot.example.com;

    location / {
        proxy_pass http://127.0.0.1:43191;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable the site and validate the config:

```bash
sudo ln -s /etc/nginx/sites-available/gh-review-bot /etc/nginx/sites-enabled/gh-review-bot
sudo nginx -t
sudo systemctl reload nginx
```

Install Certbot and issue the certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d bot.example.com
```

After Certbot finishes, verify:

```bash
curl https://bot.example.com/healthz
```

## 9. Create and Configure the GitHub App

In GitHub:

1. Go to **Settings** -> **Developer settings** -> **GitHub Apps**.
2. Click **New GitHub App**.
3. Set:
   - **GitHub App name**: choose your bot name
   - **Homepage URL**: `https://bot.example.com`
   - **Webhook URL**: `https://bot.example.com/github/webhooks`
   - **Webhook secret**: exactly the same value as `GITHUB_WEBHOOK_SECRET`
4. Repository permissions:
   - **Contents**: Read-only
   - **Pull requests**: Read and write
   - **Issues**: Read and write
5. Subscribe to the **Pull request** event.
6. Create the app.
7. Generate and download a private key.
8. Install the app on the target repository or organization repository set.

Why these permissions are needed:

- `Contents: Read-only` is used to fetch current file contents for the PR head SHA
- `Pull requests: Read and write` is used to list changed files and submit reviews
- `Issues: Read and write` is used for neutral fallback comments on failure

## 10. Verify the Webhook End to End

After installing the GitHub App:

1. Open the app settings page in GitHub.
2. Go to **Advanced** and inspect recent webhook deliveries.
3. Trigger a test by opening a PR or pushing a new commit to an existing PR.
4. Confirm:
   - GitHub receives `202 Accepted`
   - the server logs show the webhook being processed
   - the PR receives either a review or a neutral fallback comment

Useful checks:

```bash
curl https://bot.example.com/healthz
sudo journalctl -u gh-review-bot -f
codex login status
```

## 11. Updating the Deployment

When you ship a new version:

```bash
sudo -iu deploy
cd ~/tx10-bot-gh-review
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm validate
sudo systemctl restart gh-review-bot
```

If you upgraded Codex CLI:

```bash
npm install -g @openai/codex
codex --version
```

## Troubleshooting

### GitHub shows webhook delivery failures

- Verify the webhook URL is public and uses HTTPS
- Verify `nginx` is forwarding requests to `localhost:43191`
- Check `sudo journalctl -u gh-review-bot -f`

### The server returns `401` for the webhook

- The webhook secret in GitHub does not match `GITHUB_WEBHOOK_SECRET`
- A proxy is modifying the request body before the app verifies it

### The server is healthy but no PR review appears

- Confirm the event is one of `opened`, `reopened`, `synchronize`, or `review_requested`
- Confirm the PR includes supported file types with patch hunks
- Confirm the app has been installed on the repository
- Check whether the current head SHA already has a marker from an earlier run

### The PR gets a neutral failure comment

- Run `codex login status`
- Run `codex --version`
- Confirm `CODEX_BIN=codex`
- Confirm the deploy user is the same user who authenticated Codex

### The app crashes at startup

- Re-check the `.env` file
- Confirm `GITHUB_PRIVATE_KEY` is stored as one line with escaped `\n`
- Confirm `GITHUB_APP_ID` is numeric and matches the GitHub App

## Useful References

- [OpenAI Codex CLI getting started](https://help.openai.com/en/articles/11096431)
- [OpenAI Codex CLI login and ChatGPT sign-in](https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt)
- [GitHub Apps webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
