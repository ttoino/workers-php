#!/usr/bin/env bash
# Prepare ./feup-ltw-proj for bundling with workers-php.
#
#   1. Overlay router.php (Apache-style front controller).
#   2. session.php: cookie_secure conditional on HTTPS (dev is plain HTTP).
#   3. connection.php: getDBConnection() returns \WorkersPHP\D1PDO(env->DB).
#   4. files.php: uploadImage() writes resized WebP to R2 (env->IMAGES).
#   5. model.php: getImagePath() returns the canonical URL; staticRoutes
#      + missRewrite handle the placeholder fallback.
#   6. cart/index.php: add the missing lib/page.php require (upstream bug).
#   7. query.php: AggregatorClause emits a neutral boolean instead of "()"
#      (upstream bug; SQLite rejects empty parens).
#   8. Ensure every pictures/<type>/ has a default.svg for missRewrite.
#
# All edits are idempotent and confined to the gitignored clone.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PROJECT_DIR="${REPO_ROOT}/feup-ltw-proj"
readonly OVERLAY_DIR="${REPO_ROOT}/build/feup"

readonly C_BOLD=$'\033[1m'
readonly C_GREEN=$'\033[32m'
readonly C_YELLOW=$'\033[33m'
readonly C_RED=$'\033[31m'
readonly C_RESET=$'\033[0m'

log()  { printf "%s==>%s %s\n" "${C_BOLD}" "${C_RESET}" "$*" >&2; }
warn() { printf "%s==>%s %s\n" "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
fail() { printf "%sERROR:%s %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }
ok()   { printf "%s✓%s %s\n" "${C_GREEN}" "${C_RESET}" "$*" >&2; }

# Preflight

if [[ ! -d "${PROJECT_DIR}" ]]; then
	fail "Project not cloned. Run:
    git clone https://github.com/ttoino/feup-ltw-proj.git ${PROJECT_DIR}"
fi

# D1 is the source of truth (seeded via feup:migrate:*); drop stale sqlite.
rm -f "${PROJECT_DIR}/main.db" "${PROJECT_DIR}/database/main.db"

# D1 rejects PRAGMA (SQLITE_AUTH) and enables foreign keys by default, so
# stripping the lines is semantically a no-op.
log "Stripping PRAGMA lines from schema/*.sql (incompatible with D1)"
for sql in create populate triggers; do
	f="${PROJECT_DIR}/database/schema/${sql}.sql"
	[[ -f "${f}" ]] || continue
	if grep -q "^PRAGMA " "${f}"; then
		sed -i '/^PRAGMA /d' "${f}"
	fi
done
ok "PRAGMA stripped"

# 1. Overlay router.php + worker config/entrypoint

log "Installing router.php, wrangler.jsonc, worker.ts into ${PROJECT_DIR}/"
cp "${OVERLAY_DIR}/router.php" "${PROJECT_DIR}/router.php"
cp "${OVERLAY_DIR}/wrangler.jsonc" "${PROJECT_DIR}/wrangler.jsonc"
cp "${OVERLAY_DIR}/worker.ts" "${PROJECT_DIR}/worker.ts"
ok "router.php, wrangler.jsonc, worker.ts installed"

# 2. session.php: cookie_secure conditional on HTTPS

readonly SESSION_FILE="${PROJECT_DIR}/lib/session.php"
[[ -f "${SESSION_FILE}" ]] || fail "Missing ${SESSION_FILE}"

if grep -qF "// workers-php: cookie_secure made conditional" "${SESSION_FILE}"; then
	log "Re-patching ${SESSION_FILE} (cookie_secure)"
else
	log "Patching ${SESSION_FILE} (cookie_secure -> conditional on HTTPS)"
fi

python3 - "${SESSION_FILE}" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# $_SERVER['HTTPS'] is the literal 'on'/'off'; empty('off') is false, so
# compare against 'on' explicitly.
new_block = (
    "// workers-php: cookie_secure made conditional so wrangler dev (plain HTTP) keeps sessions.\n"
    "                'cookie_secure' => (($_SERVER['HTTPS'] ?? '') === 'on') ? '1' : '0',"
)
# Match the original or a previous replacement (idempotent).
patterns = [
    "'cookie_secure' => '1',",
    "// workers-php: cookie_secure made conditional so wrangler dev (plain HTTP) keeps sessions.\n                'cookie_secure' => !empty($_SERVER['HTTPS']) ? '1' : '0',",
    "// workers-php: cookie_secure made conditional so wrangler dev (plain HTTP) keeps sessions.\n                'cookie_secure' => (($_SERVER['HTTPS'] ?? '') === 'on') ? '1' : '0',",
]
for pat in patterns:
    if pat in src:
        src = src.replace(pat, new_block, 1)
        p.write_text(src)
        break
else:
    raise SystemExit(f"could not find cookie_secure assignment in {sys.argv[1]!r}")
PYEOF
ok "session.php patched"

# 3. Overlay connection.php (D1)

log "Installing D1-backed connection.php into ${PROJECT_DIR}/database/"
cp "${OVERLAY_DIR}/connection.php" "${PROJECT_DIR}/database/connection.php"
ok "connection.php overlay installed"

# 4. Overlay files.php (R2)

log "Installing R2-backed files.php into ${PROJECT_DIR}/lib/"
cp "${OVERLAY_DIR}/files.php" "${PROJECT_DIR}/lib/files.php"
ok "files.php overlay installed"

# 5. model.php: getImagePath() skips the file_exists branch

readonly MODEL_FILE="${PROJECT_DIR}/database/models/model.php"
[[ -f "${MODEL_FILE}" ]] || fail "Missing ${MODEL_FILE}"

if grep -qF "// workers-php: getImagePath simplified" "${MODEL_FILE}"; then
	log "Re-patching ${MODEL_FILE} (HasImage::getImagePath)"
else
	log "Patching ${MODEL_FILE} (HasImage::getImagePath drops file_exists fallback)"
fi

python3 - "${MODEL_FILE}" <<'PYEOF'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
src = p.read_text()

# R2 + missRewrite (build/feup/worker.ts) handle the placeholder fallback at
# the URL layer, so the body becomes a one-liner.
new_method = (
    "        function getImagePath(): string {\n"
    "            // workers-php: getImagePath simplified — staticRoutes/missRewrite\n"
    "            // serves /assets/pictures/<folder>/default.svg from ASSETS when R2\n"
    "            // has no <id>.webp yet.\n"
    "            $folder = static::getImageFolder();\n"
    "            return \"/assets/pictures/$folder/$this->id.webp\";\n"
    "        }"
)

pattern = re.compile(
    r"        function getImagePath\(\): string \{[\s\S]*?\n        \}",
    re.MULTILINE,
)
m = pattern.search(src)
if not m:
    raise SystemExit("Could not locate HasImage::getImagePath() body")
src = src[:m.start()] + new_method + src[m.end():]
p.write_text(src)
PYEOF
ok "model.php patched"

# 6. cart/index.php: add the missing lib/page.php require

readonly CART_FILE="${PROJECT_DIR}/cart/index.php"
[[ -f "${CART_FILE}" ]] || fail "Missing ${CART_FILE}"

if grep -qF "// workers-php: ensure pageError() is available" "${CART_FILE}"; then
	ok "cart/index.php already patched"
else
	log "Patching ${CART_FILE} (add missing require for lib/page.php)"
	python3 - "${CART_FILE}" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# Anchor: the lib/session.php require is the last lib/ load in the file.
needle = "    require_once('../lib/session.php');"
if needle not in src:
    raise SystemExit("could not find lib/session.php require in cart/index.php")
inject = needle + "\n    require_once('../lib/page.php'); // workers-php: ensure pageError() is available"
src = src.replace(needle, inject, 1)
p.write_text(src)
PYEOF
	ok "cart/index.php patched"
fi

# 7. query.php: AggregatorClause with an empty clause list

readonly QUERY_FILE="${PROJECT_DIR}/database/models/query.php"
[[ -f "${QUERY_FILE}" ]] || fail "Missing ${QUERY_FILE}"

if grep -qF "// workers-php: an all-null clause list" "${QUERY_FILE}"; then
	ok "query.php already patched"
else
	log "Patching ${QUERY_FILE} (AggregatorClause: empty list -> 1=1 / 1=0)"
	python3 - "${QUERY_FILE}" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# An all-null clause list (e.g. /search/ with no filters) must not emit
# "()": SQLite rejects empty parens. Use the aggregation's neutral element.
needle = '            $this->queryString = sprintf("(%s)", implode(sprintf(" %s ", static::getAggregationType()->value), $attrs));'
replacement = (
    "            // workers-php: an all-null clause list must not emit \"()\" —\n"
    "            // SQLite rejects empty parens. Use the aggregation's neutral\n"
    "            // element so the clause degenerates to a no-op.\n"
    "            if (count($attrs) === 0)\n"
    "                $attrs[] = static::getAggregationType() === AggregationType::AND ? '1=1' : '1=0';\n"
    "\n"
    + needle
)
if needle not in src:
    raise SystemExit("could not find AggregatorClause queryString assignment in query.php")
src = src.replace(needle, replacement, 1)
p.write_text(src)
PYEOF
	ok "query.php patched"
fi

# 8. Normalise default-image filenames
#
# missRewrite swaps <id>.webp → default.svg uniformly, so folders that
# only ship default<N>.svg get a plain default.svg copy.

readonly PICTURES_DIR="${PROJECT_DIR}/assets/pictures"
for folder in user dish menu restaurant; do
	dst="${PICTURES_DIR}/${folder}/default.svg"
	if [[ -f "${dst}" ]]; then
		continue
	fi
	src="${PICTURES_DIR}/${folder}/default0.svg"
	if [[ ! -f "${src}" ]]; then
		src=$(ls "${PICTURES_DIR}/${folder}/default"*.svg 2>/dev/null | head -1)
	fi
	if [[ -n "${src}" && -f "${src}" ]]; then
		cp -f "${src}" "${dst}"
		ok "Copied default.svg into ${folder}/"
	fi
done

echo
ok "feup-ltw-proj is ready to bundle. Next:"
echo "    npx workers-php build ${PROJECT_DIR} \\"
echo "        --out ${REPO_ROOT}/dist-feup \\"
echo "        --docroot . --entrypoint router.php"
