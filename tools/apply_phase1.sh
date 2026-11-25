#!/usr/bin/env bash
# Historical Phase 1 entry point. Preflight only until an application exists.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
missing=0
for path in package.json src; do
  if [[ ! -e "$path" ]]; then
    printf 'BLOCKED: missing application prerequisite: %s\n' "$path" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  echo 'This repository currently contains engineering specifications, not a runnable application.' >&2
  exit 2
fi
if [[ ! -f pnpm-lock.yaml && ! -f bun.lock && ! -f bun.lockb && ! -f package-lock.json ]]; then
  echo 'BLOCKED: no committed package lockfile; establish the application toolchain first.' >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'BLOCKED: working tree is not clean. Use an isolated worktree.' >&2
  exit 2
fi
echo 'Preflight passed only. Review actual framework, lockfile and CI before implementation.'
echo 'No files, branches, credentials or remote repository were changed.'
