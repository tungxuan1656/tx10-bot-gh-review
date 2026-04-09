# Deployment Guide

This guide walks through a production-style Linux deployment for the review bot using a dedicated machine user on GitHub. The service receives repository or organization webhooks, verifies their signature, and only reviews a pull request when that machine user is explicitly requested as a reviewer.

## Recommended Topology

- Ubuntu 22.04 or 24.04 server
- one non-root deploy user
- Node.js 22
- pnpm via `corepack`
- Codex CLI installed on the host
- app process managed by `systemd`
- `nginx` terminating TLS and proxying to `localhost:43191`
- GitHub repository or organization webhook pointing to `https://bot.example.com/github/webhooks`

## Prerequisites

Before starting, make sure you have:

- a public domain such as `bot.example.com`
- a Linux server with outbound internet access
- an OpenAI account that can use Codex CLI
- a dedicated GitHub account that will act as the reviewer bot
- a fine-grained PAT for that account, or a classic PAT if your GitHub policy requires it
- this repository available on the server

## 1. Prepare the Server

```bash
sudo apt update
sudo apt install -y curl git nginx build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@10.28.1 --activate
```

Optional dedicated user:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG sudo deploy
sudo -iu deploy
```

## 2. Clone and Build the App

```bash
git clone <YOUR_REPO_URL> ~/tx10-bot-gh-review
cd ~/tx10-bot-gh-review
pnpm install --frozen-lockfile
pnpm build
pnpm validate
```

## 3. Install and Authenticate Codex CLI

```bash
npm install -g @openai/codex
codex --version
```

Sign in with ChatGPT:

```bash
codex --login
codex login status
```

Or use an API key:

```bash
export OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

Do not continue until `codex login status` shows a valid login.

## 4. Create the Runtime Environment File

Create `~/tx10-bot-gh-review/.env`:

```bash
cat > ~/tx10-bot-gh-review/.env <<'EOF'
PORT=43191
LOG_LEVEL=info
CODEX_BIN=codex
GITHUB_TOKEN=ghp_replace_me
GITHUB_BOT_LOGIN=review-bot
GITHUB_WEBHOOK_SECRET=replace-with-random-secret
EOF
```

Notes:

- `GITHUB_TOKEN` should belong to the machine user that will submit reviews.
- `GITHUB_BOT_LOGIN` must exactly match that account's GitHub login.
- `GITHUB_WEBHOOK_SECRET` must exactly match the repository or organization webhook secret.

Lock down the file:

```bash
chmod 600 ~/tx10-bot-gh-review/.env
```

## 5. Smoke Test the App Locally on the Server

```bash
cd ~/tx10-bot-gh-review
set -a
source .env
set +a
node dist/http/index.js
```

In a second shell:

```bash
curl http://127.0.0.1:43191/healthz
```

Expected response:

```json
{"status":"ok"}
```

## 6. Create a systemd Service

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
sudo journalctl -u gh-review-bot -f
```

## 7. Configure nginx and HTTPS

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

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/gh-review-bot /etc/nginx/sites-enabled/gh-review-bot
sudo nginx -t
sudo systemctl reload nginx
```

Then provision TLS with your preferred method such as Let's Encrypt.

## 8. Configure the GitHub Side

1. Add the machine user to the repository or organization with enough access to review pull requests.
2. Create either a repository webhook or an organization webhook.
3. Point the webhook to `https://bot.example.com/github/webhooks`.
4. Enable the `Pull requests` event.
5. Set the webhook secret to the same value as `GITHUB_WEBHOOK_SECRET`.

Behavior notes:

- The service only runs on `pull_request` events with action `review_requested`.
- The service ignores the event unless `requested_reviewer.login === GITHUB_BOT_LOGIN`.
- New commits do not trigger automatic re-review; someone must request review from the bot again.

## Troubleshooting

### The webhook returns `401`

- Confirm the webhook secret exactly matches `GITHUB_WEBHOOK_SECRET`.
- Confirm proxies are not rewriting the raw request body.

### The bot does not review after a PR update

- This is expected until the machine user is requested again.
- Ask GitHub to request review from the bot account one more time.

### The bot can read PRs but cannot submit reviews

- Check the machine user's repository access.
- Confirm the token still has the scopes or fine-grained permissions required to read pull requests and create reviews or issue comments.
