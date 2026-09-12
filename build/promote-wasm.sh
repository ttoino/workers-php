#!/usr/bin/env bash
# Promote wasm/*.staged files into their canonical names.
#
# Run after `npm run build-wasm` once the staged artifacts are verified.
# Each replaced file is kept as *.legacy; re-runs are safe.

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

# PhpWeb.mjs is absent on purpose: upstream's version is unusable on
# Workers (dynamic imports + navigator.locks), so a hand-written one is
# maintained in packages/workers-php/src/wasm/.
FILES=(
	php-web.mjs
	php-web.wasm
	PhpBase.mjs
	OutputBuffer.mjs
	_Event.mjs
	fsOps.mjs
	resolveDependencies.mjs
)

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
