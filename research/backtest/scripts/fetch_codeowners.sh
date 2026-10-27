#!/bin/bash
# Half-monthly CODEOWNERS snapshots (read-only GETs).
D=$(dirname "$0")/../data/codeowners
for repo in seer sentry ops getsentry; do
  for date in 2026-04-15 2026-05-01 2026-05-15 2026-06-01 2026-06-15 2026-07-01 2026-07-15 2026-08-01 2026-08-15 2026-09-01 2026-09-15 2026-10-01 2026-10-15; do
    sha=$(gh api "repos/getsentry/$repo/commits?path=.github/CODEOWNERS&until=${date}T00:00:00Z&per_page=1" --jq '.[0].sha' 2>/dev/null)
    [ -z "$sha" ] && { echo "$repo $date none"; continue; }
    f="$D/${repo}_${sha}.txt"
    [ -f "$f" ] || gh api "repos/getsentry/$repo/contents/.github/CODEOWNERS?ref=$sha" --jq '.content' | base64 -d > "$f"
    echo -e "$repo\t$date\t$sha" >> "$D/index.tsv"
  done
done
