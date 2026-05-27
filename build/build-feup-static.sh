#!/usr/bin/env bash
# Copy feup-ltw-proj's static assets directly into dist-feup/ so Wrangler's
# ASSETS binding serves them via env.ASSETS.fetch() without the PHP runtime
# in the path.
#
# Why: workers-php's static-extension short-circuit forwards every .css/.js/
# .png/etc. request straight to env.ASSETS.fetch(request). For that to
# return real bytes, the file has to live as an ASSET on disk — Wrangler
# matches by URL path (e.g. /style/index.css → dist-feup/style/index.css).
# If we only ship app.tar.gz in dist-feup/, all those requests 404.
#
# The project's CSS/JS/images are also inside app.tar.gz (they're part of
# the mounted FS so PHP can read them too), so we accept a small amount of
# duplication. Total static footprint here is ~430 KB.
#
# Runs after `workers-php build`. Idempotent — wipes the previous copies
# first.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PROJECT_DIR="${REPO_ROOT}/feup-ltw-proj"
readonly DIST_DIR="${REPO_ROOT}/dist-feup"

readonly C_BOLD=$'\033[1m'
readonly C_GREEN=$'\033[32m'
readonly C_RED=$'\033[31m'
readonly C_RESET=$'\033[0m'

log()  { printf "%s==>%s %s\n" "${C_BOLD}" "${C_RESET}" "$*" >&2; }
fail() { printf "%sERROR:%s %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }
ok()   { printf "%s✓%s %s\n" "${C_GREEN}" "${C_RESET}" "$*" >&2; }

[[ -d "${PROJECT_DIR}" ]] || fail "Missing ${PROJECT_DIR}"
[[ -d "${DIST_DIR}" ]] || fail "Missing ${DIST_DIR} (run 'workers-php build' first)"

# Directories whose contents are static and addressed by absolute URL.
# Keep these in sync with the references in templates/common.php and
# index.php (<link rel=...>, <script src=...>, <img src=...>).
readonly STATIC_DIRS=(style scripts assets)

log "Copying static assets into ${DIST_DIR}/"
for d in "${STATIC_DIRS[@]}"; do
	src="${PROJECT_DIR}/${d}"
	dst="${DIST_DIR}/${d}"
	if [[ ! -d "${src}" ]]; then
		printf "  - skipped %s (not present in project)\n" "${d}" >&2
		continue
	fi
	rm -rf "${dst}"
	cp -a "${src}" "${dst}"
	bytes="$(du -sb "${dst}" | cut -f1)"
	printf "  - %-10s %s bytes\n" "${d}/" "${bytes}" >&2
done

ok "Static assets copied"
