#!/usr/bin/env bash
# Confirms GitHub Pages is really serving the build that was just published. Without this, a run can
# go green while the live site is missing, stale, or pointing at the wrong path.
#
#   .github/check-live-site.sh <site url> <built site folder> [attempts]
set -euo pipefail

url="${1%/}/"
built="$2"
attempts="${3:-30}"

# Bundle names contain a hash of their contents, so this one identifies exactly this build.
expected="$(grep -oE 'main-[A-Za-z0-9_-]+\.js' "$built/index.html" | head -1)"
if [ -z "$expected" ]; then
  echo "::error::No main bundle found in $built/index.html"
  exit 1
fi

# Pages takes a moment to deploy, and its CDN caches pages, so keep asking with a unique query.
for i in $(seq 1 "$attempts"); do
  page="$(curl -fsSL "${url}?check=${GITHUB_SHA:-local}-$i" || true)"
  case "$page" in
    *"$expected"*)
      echo "Serving this build: $expected"
      for path in "" progress/ login/ favicon.svg "$expected"; do
        status="$(curl -sSL -o /dev/null -w '%{http_code}' "${url}${path}?check=${GITHUB_SHA:-local}-$i")"
        echo "  $status  ${url}${path}"
        if [ "$status" != 200 ]; then
          echo "::error::${url}${path} returned $status"
          exit 1
        fi
      done
      exit 0
      ;;
  esac
  echo "Attempt $i of $attempts: not live yet"
  sleep 10
done

echo "::error::${url} didn't start serving this build ($expected). Check the repo's Settings > Pages: the source should be the gh-pages branch."
exit 1
