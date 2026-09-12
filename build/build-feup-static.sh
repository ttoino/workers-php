#!/usr/bin/env bash
# Copy feup-ltw-proj's static assets into dist-feup/ for direct ASSETS
# serving.
#
# The static short-circuit forwards .css/.js/... requests to
# env.ASSETS.fetch(), which only finds files that exist on disk; with only
# app.tar.gz present those requests 404. The same files also live inside
# the tarball (PHP reads them from the mounted FS), so the duplication is
# deliberate (~430 KB).
#
# Runs after `workers-php build`. Idempotent — previous copies are wiped.

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

# Keep in sync with the asset references in templates/common.php and
# index.php (<link>, <script>, <img>).
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
