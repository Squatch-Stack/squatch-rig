#!/usr/bin/env bash
# Fail if a package-lock.json changed against BASE (default origin/main) adds a package version younger than
# 14 days. Used by .github/workflows/lockfile-age.yml and runnable by hand before you push:
#   tools/check-lockfile-age.sh [BASE_REF]
# Why this and not only .npmrc min-release-age: `npm ci` installs the lockfile as written, so the lockfile
# diff is the gate (tools/npm_lock_age.py). Exceptions: tools/npm-lock-age-exceptions.toml, owner only.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"
base_sha="$(git merge-base "$base" HEAD)"
locks=()
while IFS= read -r f; do locks+=("$f"); done < <(git diff --name-only --diff-filter=AM "$base_sha" HEAD -- '*package-lock.json')
if [ "${#locks[@]}" -eq 0 ]; then echo "lockfile-age: no package-lock.json changed against $base"; exit 0; fi
printf 'lockfile-age: checking %s\n' "${locks[@]}"
exec python3 -I tools/npm_lock_age.py --base "$base_sha" "${locks[@]}"
