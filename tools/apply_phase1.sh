#!/usr/bin/env bash
set -euo pipefail

BRANCH="audit/phase-1-ci-and-secrets"
REMOTE="origin"
MAIN_BRANCH="main"

# Ensure on main and up-to-date
git fetch "$REMOTE"
git checkout "$MAIN_BRANCH"
git pull "$REMOTE" "$MAIN_BRANCH"

# Create branch
git checkout -b "$BRANCH"

# Create directories
mkdir -p .github/workflows scripts

# Write CI workflow (pnpm)
cat > .github/workflows/ci.yml <<'YAML'
name: CI (pnpm)

on:
  push:
    branches: ["main", "master"]
  pull_request:
    branches: ["main", "master"]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: ["18.x"]
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}

      - name: Install pnpm
        run: npm install -g pnpm@latest

      - name: Install dependencies (pnpm)
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm exec tsc --noEmit

      - name: Lint
        run: pnpm run lint

      - name: Unit tests (Vitest)
        run: pnpm run test

      - name: Build (production)
        run: pnpm run build
YAML

# Write Bun workflow
cat > .github/workflows/ci-bun.yml <<'YAML'
name: CI (bun - experimental)

on:
  workflow_dispatch:
  push:
    branches: ["main", "master"]
  pull_request:
    branches: ["main", "master"]

jobs:
  build-and-test-bun:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js (for tsc compatibility)
        uses: actions/setup-node@v4
        with:
          node-version: "18.x"

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: "latest"

      - name: Install dependencies (bun)
        run: bun install

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Lint
        run: npx eslint . || pnpm run lint

      - name: Unit tests (Vitest) - may require adaptation for Bun
        run: npx vitest run

      - name: Build (vite)
        run: npx vite build
YAML

# Write .env.example
cat > .env.example <<'ENV'
# Copy to .env and fill with real values (DO NOT commit .env)
# Supabase
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# AI (Gemini)
GEMINI_API_KEY=your-gemini-api-key

# WhatsApp Business API
WHATSAPP_TOKEN=your-whatsapp-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id

# App URL
VITE_APP_URL=http://localhost:5173
ENV

# Write .gitignore
cat > .gitignore <<'TXT'
# Local environment variables
.env
.env.local
.env.*.local

# Node modules / build outputs
node_modules
dist
dist-ssr
.output

# Editor directories
.vscode/*
.idea
.DS_Store

# Lockfiles (DO NOT ignore the lockfile you choose to commit)
# If you plan to use pnpm, commit pnpm-lock.yaml. If you use bun, commit bun.lockb.
TXT

# README-ci.md
cat > README-ci.md <<'MD'
# Local checks & CI

Recommended package manager: pnpm (recommended for CI).
Local quickstart:
1. Install pnpm: npm i -g pnpm
2. Install dependencies: pnpm install
3. Typecheck: pnpm exec tsc --noEmit
4. Lint: pnpm run lint
5. Unit tests: pnpm run test
6. Build: pnpm run build

If you use Bun locally:
1. bun install
2. npx tsc --noEmit
3. npx vitest run
4. npx vite build
(Adjust as needed; Bun support may require tweaks.)

Important:
- DO NOT commit a .env file with real secrets. Use .env.example for placeholders.
- After you run `pnpm install`, commit the generated pnpm-lock.yaml (recommended) so CI can use --frozen-lockfile.
MD

# dependabot
mkdir -p .github
cat > .github/dependabot.yml <<'YAML'
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    allow:
      - dependency-type: "production"
      - dependency-type: "development"
YAML

# cleanup script
cat > scripts/cleanup-secrets.sh <<'SH'
#!/bin/bash
# scripts/cleanup-secrets.sh
set -euo pipefail

echo "Removing local .env if present..."
if [ -f .env ]; then
  shred -u .env || rm -f .env
fi

echo "Searching repository for likely secrets..."
grep -R --line-number --exclude-dir=.git . -E "(SUPABASE|GEMINI|WHATSAPP|TOKEN|SECRET|API_KEY)" || true

cat <<'USAGE'

To purge secrets from history with BFG (recommended):
  1. Install BFG: https://rtyley.github.io/bfg-repo-cleaner/
  2. Create `secrets-to-clean.txt` with the exact secrets (one per line).
  3. Run:
     java -jar bfg.jar --replace-text secrets-to-clean.txt
     git reflog expire --expire=now --all && git gc --prune=now --aggressive
  4. Force push (coordinate with team):
     git push --force

Alternatively with git-filter-repo:
  pip install git-filter-repo
  git filter-repo --replace-text secrets-to-clean.txt

After purging, rotate all exposed keys in external providers (Supabase, WhatsApp, Gemini).
USAGE
SH

chmod +x scripts/cleanup-secrets.sh

# Commit & push
git add .github .env.example .gitignore README-ci.md scripts .github/dependabot.yml
git commit -m "chore(audit): add CI (pnpm & bun), .env.example, dependabot, README-ci, gitignore, cleanup script"
git push -u "$REMOTE" "$BRANCH"

# Generate pnpm-lock.yaml
if command -v pnpm >/dev/null 2>&1; then
  echo "pnpm detected, installing to generate lockfile..."
  pnpm install
  git add pnpm-lock.yaml
  git commit -m "chore: add pnpm-lock.yaml" || true
  git push
else
  echo "pnpm not found. Please run 'npm i -g pnpm' and 'pnpm install' locally to generate pnpm-lock.yaml"
fi

echo "Done. Please open a Pull Request from $BRANCH into $MAIN_BRANCH on GitHub."
echo "If you have gh CLI configured you can run: gh pr create --base $MAIN_BRANCH --head $BRANCH --title \"chore(audit): Phase 1 - CI & secrets\" --body \"Adds CI workflows, .env.example, .gitignore, dependabot, and cleanup script.\""
