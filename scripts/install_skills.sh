#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REPO_URL="https://github.com/affaan-m/everything-claude-code"
TMP_DIR="$PROJECT_ROOT/.tmp/everything-claude-code"
DEST_DIR="$PROJECT_ROOT/.agents/skills"

SRC_SKILLS="$TMP_DIR/skills"
SRC_AGENTS="$TMP_DIR/agents"

# Skills from the previously listed frontend/backend/common sets.
REQUESTED_SKILLS=(
  frontend-patterns
  frontend-design
  design-system
  frontend-slides
  e2e-testing
  ui-demo
  browser-qa

  hexagonal-architecture
  backend-patterns
  nestjs-patterns
  database-migrations
  postgres-patterns
  jpa-patterns
  api-design
  api-connector-builder
  mcp-server-patterns
  nodejs-keccak256

  tdd-workflow
  benchmark
  git-workflow
  deployment-patterns
  docker-patterns
  code-tour
  codebase-onboarding
  documentation-lookup
  terminal-ops
  exa-search
  deep-research
  coding-standards
)

# Agents relevant to frontend + backend + common workflows for React, React Native, and Node.js.
REQUESTED_AGENTS=(
  build-error-resolver
  comment-analyzer
  database-reviewer
  doc-updater
  docs-lookup
  e2e-runner
  performance-optimizer
  planner
  pr-test-analyzer
  refactor-cleaner
  security-reviewer
  silent-failure-hunter
  tdd-guide
  type-design-analyzer
  typescript-reviewer
)

mkdir -p "$DEST_DIR"
mkdir -p "$PROJECT_ROOT/.tmp"

if [[ -d "$TMP_DIR" ]]; then
  rm -rf "$TMP_DIR"
fi

echo "Cloning $REPO_URL ..."
git clone --depth 1 "$REPO_URL" "$TMP_DIR"

if [[ ! -d "$SRC_SKILLS" ]]; then
  echo "ERROR: skills directory not found in cloned repository: $SRC_SKILLS"
  exit 1
fi

if [[ ! -d "$SRC_AGENTS" ]]; then
  echo "ERROR: agents directory not found in cloned repository: $SRC_AGENTS"
  exit 1
fi

copied_skills=0
missing_skills=0

copy_skill() {
  local skill_name="$1"
  local src="$SRC_SKILLS/$skill_name"
  local dest="$DEST_DIR/$skill_name"

  if [[ -d "$src" ]]; then
    rm -rf "$dest"
    cp -R "$src" "$dest"
    echo "[skill] copied: $skill_name"
    copied_skills=$((copied_skills + 1))
  else
    echo "[skill] missing, skipped: $skill_name"
    missing_skills=$((missing_skills + 1))
  fi
}

echo ""
echo "Copying requested skills to $DEST_DIR ..."
for skill in "${REQUESTED_SKILLS[@]}"; do
  copy_skill "$skill"
done

converted_agents=0
skipped_agents=0

is_requested_agent() {
  local agent_name="$1"
  for requested_agent in "${REQUESTED_AGENTS[@]}"; do
    if [[ "$requested_agent" == "$agent_name" ]]; then
      return 0
    fi
  done
  return 1
}

echo ""
echo "Converting agents to skill format ..."
for agent_file in "$SRC_AGENTS"/*.md; do
  [[ -e "$agent_file" ]] || continue

  agent_name="$(basename "$agent_file" .md)"
  if ! is_requested_agent "$agent_name"; then
    rm -rf "$DEST_DIR/$agent_name"
    echo "[agent] skipped (not requested): $agent_name"
    skipped_agents=$((skipped_agents + 1))
    continue
  fi

  agent_dest_dir="$DEST_DIR/$agent_name"
  mkdir -p "$agent_dest_dir"

  cp "$agent_file" "$agent_dest_dir/SKILL.md"
  echo "[agent] converted: $agent_name -> $agent_dest_dir/SKILL.md"
  converted_agents=$((converted_agents + 1))
done

rm -rf "$TMP_DIR"

echo ""
echo "Done."
echo "- Skills copied: $copied_skills"
echo "- Skills missing/skipped: $missing_skills"
echo "- Agents converted: $converted_agents"
echo "- Agents skipped: $skipped_agents"
echo "- Destination: $DEST_DIR"


set -e

git clone --depth 1 https://github.com/sickn33/antigravity-awesome-skills.git

SOURCE="./antigravity-awesome-skills/skills"
DEST="./.agents/skills"

echo "Creating project skills directory..."
mkdir -p "$DEST"

copy_skill () {
  if [ -d "$SOURCE/$1" ]; then
    echo "Installing skill: $1"
    cp -R "$SOURCE/$1" "$DEST/"
  else
    echo "Skipping missing skill: $1"
  fi
}


echo ""
echo "Installing core skills..."

core_skills=(
  systematic-debugging
  lint-and-validate
  verification-before-completion
  concise-planning
  react-native-architecture
  react-component-performance
  i18n-localization
  e2e-testing-patterns
  browser-automation
  code-documentation-doc-generate
  building-native-ui
  expo-api-routes
  expo-tailwind-setup
  tailwind-design-system
  tailwind-patterns
  shadcn
  monorepo-architect
  mobile-security-coder
)

for skill in "${core_skills[@]}"; do
  copy_skill "$skill"
done

rm -rf antigravity-awesome-skills

echo ""
# sh scripts/sync_gitnexus.sh