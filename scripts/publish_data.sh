#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only origin main

python3 scripts/build_public_data.py "$@"

updated_at="$(python3 -c 'import json; print(json.load(open("data.json", encoding="utf-8"))["updated_at"])')"

# git diff stays quiet for an untracked data.json, so also look at status.
if git diff --quiet -- data.json && git diff --quiet --cached -- data.json && [ -z "$(git status --porcelain -- data.json)" ]; then
  echo "data.json unchanged, nothing to publish"
else
  git add data.json
  git commit -m "data: update ${updated_at}"
  git push origin main
fi

echo "https://mjlembo88.github.io/truck-deals/data.json"
echo "${updated_at}"
