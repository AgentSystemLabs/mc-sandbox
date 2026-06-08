#!/usr/bin/env bash
set -Eeuo pipefail

exec > >(tee -a /var/log/mission-control-agent-install.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

echo "[mission-control] golden image install started at $(date -Is)"
apt-get update
apt-get install -y --no-install-recommends \
  bash build-essential ca-certificates curl git gnupg jq less openssh-client openssl procps \
  python3 python3-pip python3-venv ripgrep sudo unzip xz-utils zip zsh

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" != "24" ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# GitHub CLI (gh) from the official apt repo (signed-by keyring, arch-matched).
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh

if ! id -u workspace >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash workspace
fi
usermod -aG sudo workspace
echo "workspace ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/workspace
chmod 0440 /etc/sudoers.d/workspace

install -d -o workspace -g workspace -m 0755 /workspace
install -d -o workspace -g workspace -m 0700 /home/workspace/.ssh
install -d -o workspace -g workspace -m 0755 /home/workspace/.config

corepack enable
corepack prepare pnpm@11.1.2 --activate
npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest opencode-ai@latest @agentsystemlabs/mission-control-agent@latest

# Fail fast if the agent binary is not on PATH after install (e.g. a bad publish).
# npm's global prefix on the NodeSource deb is /usr, so the bin lands in /usr/bin —
# do NOT assume /usr/local/bin. The systemd unit below resolves it via PATH.
if ! command -v mission-control-agent >/dev/null 2>&1; then
  echo "[mission-control] FATAL: mission-control-agent not found on PATH after 'npm install -g'."
  echo "[mission-control] PATH=$PATH"
  npm ls -g --depth=0 || true
  exit 1
fi
echo "[mission-control] agent binary resolved to: $(command -v mission-control-agent)"

sudo -H -u workspace env HOME=/home/workspace PATH=/home/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin bash -lc \
  'for i in 1 2 3; do curl https://cursor.com/install -fsS | bash && break; echo "cursor-agent install attempt $i failed; retrying in 5s..."; sleep 5; done || echo "WARNING: cursor-agent install failed; continuing without it"'
ln -sf /home/workspace/.local/bin/cursor-agent /usr/local/bin/cursor-agent || true
ln -sf /home/workspace/.local/bin/agent /usr/local/bin/agent || true
echo "[mission-control] golden image install complete at $(date -Is)"
