#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
npm run build
site_dir="$repo_dir/build/priceleaf-web"
if [[ ! -f "$site_dir/.vercel/project.json" ]]; then
    vercel link --cwd "$site_dir" --project priceleaf-catalog --yes
fi
vercel deploy --cwd "$site_dir" --prod --yes
