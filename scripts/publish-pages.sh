#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/web"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
GITHUB_PAGES=true npm run build
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R dist/. "$tmp/"
touch "$tmp/.nojekyll"
cd "$tmp"
git init -b gh-pages
git config user.name "Harshvardhan"
git config user.email "hv4626@users.noreply.github.com"
git add -A
git commit -m "Publish L2 capability allocation console to GitHub Pages"
git remote add origin https://github.com/hv4626/l2-capability-allocation.git
git push -f origin gh-pages
echo "Pushed gh-pages. Site: https://hv4626.github.io/l2-capability-allocation/"
