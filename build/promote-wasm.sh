#!/usr/bin/env bash
# Promote staged wasm/*.staged files into their canonical names.
#
# Run after `npm run build-wasm` has produced the .staged files and you've
# verified they work (e.g. via `npx wrangler dev` + curl).
#
# For each promoted file, the previous version is backed up as `*.legacy`.
# Re-run is safe; legacy files from prior promotions are overwritten.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly WASM_DIR="${REPO_ROOT}/packages/workers-php/src/wasm"

readonly C_BOLD=$'\033[1m'
readonly C_GREEN=$'\033[32m'
readonly C_RED=$'\033[31m'
readonly C_RESET=$'\033[0m'

log()  { printf "%s==>%s %s\n" "${C_BOLD}" "${C_RESET}" "$*" >&2; }
fail() { printf "%sERROR:%s %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }
ok()   { printf "%s✓%s %s\n" "${C_GREEN}" "${C_RESET}" "$*" >&2; }

# Files we expect every build to produce. PhpWeb.mjs intentionally NOT here:
# the upstream version is incompatible with Cloudflare Workers (dynamic imports
# + navigator.locks), so we maintain our own PhpWeb.mjs by hand in
# packages/workers-php/src/wasm/.
FILES=(
	php-web.mjs
	php-web.wasm
	PhpBase.mjs
	OutputBuffer.mjs
	_Event.mjs
	fsOps.mjs
	resolveDependencies.mjs
)

# Pre-check: every .staged must exist.
missing=()
for name in "${FILES[@]}"; do
	[[ -f "${WASM_DIR}/${name}.staged" ]] || missing+=( "${name}.staged" )
done
if (( ${#missing[@]} )); then
	fail "Missing staged file(s): ${missing[*]}. Run \`npm run build-wasm\` first."
fi

for name in "${FILES[@]}"; do
	staged="${WASM_DIR}/${name}.staged"
	active="${WASM_DIR}/${name}"
	legacy="${WASM_DIR}/${name}.legacy"

	if [[ -f "${active}" ]]; then
		log "${name} → ${name}.legacy"
		mv -f "${active}" "${legacy}"
	fi
	mv -f "${staged}" "${active}"
done

ok "Promoted all staged files"
log "Old files retained as ${WASM_DIR}/*.legacy; delete with \`rm ${WASM_DIR}/*.legacy\` when satisfied"
