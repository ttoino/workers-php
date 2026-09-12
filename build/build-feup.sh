#!/usr/bin/env bash
# Prepare ./feup-ltw-proj for bundling with workers-php.
#
# This is where the project tree is patched/overlaid for serverless
# execution:
#
#   1. Overlay router.php into the project root (Apache-style front
#      controller).
#   2. Patch lib/session.php so cookie_secure is conditional on HTTPS
#      (wrangler dev runs over plain HTTP).
#   3. Overlay database/connection.php so getDBConnection() returns a
#      \WorkersPHP\D1PDO instance pointed at the env->DB binding.
#   4. Overlay lib/files.php so uploadImage() writes the resized WebP
#      bytes to the env->IMAGES R2 binding instead of MEMFS.
#   5. Patch database/models/model.php's HasImage trait so getImagePath()
#      just returns the canonical URL — staticRoutes + missRewrite serve
#      the right bytes (R2 upload or ASSETS default.svg).
#   6. Patch cart/index.php to add the missing require_once for
#      lib/page.php (upstream bug; surfaces only as a 500 right now).
#   7. Patch database/models/query.php's AggregatorClause so an all-null
#      clause list emits a neutral boolean instead of "()" (upstream bug;
#      SQLite rejects empty parens — surfaced as /search/?q=... → 500).
#   8. Copy the project's default*.svg image-folder placeholders so a
#      single `default.svg` exists in every <type>/ folder — staticRoutes
#      missRewrite rewrites <id>.webp → default.svg uniformly.
#
# All edits are idempotent and confined to the gitignored project clone.

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

# ---------- Preflight ----------

if [[ ! -d "${PROJECT_DIR}" ]]; then
	fail "Project not cloned. Run:
    git clone https://github.com/ttoino/feup-ltw-proj.git ${PROJECT_DIR}"
fi

# We no longer seed a local sqlite main.db — D1 is the source of truth.
# Schema seeding happens through the npm run feup:migrate:{local,remote}
# scripts, which shell out to `wrangler d1 execute`. Remove any stale db.
rm -f "${PROJECT_DIR}/main.db" "${PROJECT_DIR}/database/main.db"

# D1's SQL runner doesn't allow PRAGMA statements (SQLITE_AUTH).  Strip the
# `PRAGMA FOREIGN_KEYS = ON;` line from the three schema files. D1 enables
# foreign keys by default, so this is a no-op semantically.
log "Stripping PRAGMA lines from schema/*.sql (incompatible with D1)"
for sql in create populate triggers; do
	f="${PROJECT_DIR}/database/schema/${sql}.sql"
	[[ -f "${f}" ]] || continue
	if grep -q "^PRAGMA " "${f}"; then
		sed -i '/^PRAGMA /d' "${f}"
	fi
done
ok "PRAGMA stripped"

# ---------- 1. Overlay router.php ----------

log "Installing router.php into ${PROJECT_DIR}/"
cp "${OVERLAY_DIR}/router.php" "${PROJECT_DIR}/router.php"
ok "router.php installed"

# ---------- 2. Patch lib/session.php for HTTP local dev ----------

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
# The workers-php CGI prelude sets $_SERVER['HTTPS'] = 'on' over HTTPS and
# 'off' over HTTP. PHP's empty('off') is false, so we have to compare for
# the literal 'on' string instead of using empty().
new_block = (
    "// workers-php: cookie_secure made conditional so wrangler dev (plain HTTP) keeps sessions.\n"
    "                'cookie_secure' => (($_SERVER['HTTPS'] ?? '') === 'on') ? '1' : '0',"
)
# Match the original literal, or our own previous (buggy) replacement.
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

# ---------- 3. Overlay database/connection.php (D1 instead of sqlite) ----------

log "Installing D1-backed connection.php into ${PROJECT_DIR}/database/"
cp "${OVERLAY_DIR}/connection.php" "${PROJECT_DIR}/database/connection.php"
ok "connection.php overlay installed"

# ---------- 4. Overlay lib/files.php (R2 instead of MEMFS) ----------

log "Installing R2-backed files.php into ${PROJECT_DIR}/lib/"
cp "${OVERLAY_DIR}/files.php" "${PROJECT_DIR}/lib/files.php"
ok "files.php overlay installed"

# ---------- 5. Patch HasImage::getImagePath() to skip the file_exists branch ----------

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

# Replace the entire getImagePath() body with a one-liner. R2 + missRewrite
# in src/feup-index.ts handle the default-image fallback at the URL layer.
new_method = (
    "        function getImagePath(): string {\n"
    "            // workers-php: getImagePath simplified — staticRoutes/missRewrite\n"
    "            // serves /assets/pictures/<folder>/default.svg from ASSETS when R2\n"
    "            // has no <id>.webp yet.\n"
    "            $folder = static::getImageFolder();\n"
    "            return \"/assets/pictures/$folder/$this->id.webp\";\n"
    "        }"
)

# Find and replace by regex. We anchor on the exact original body to avoid
# accidentally double-patching.
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

# ---------- 6. Fix cart/index.php (upstream forgets require_once lib/page.php) ----------

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
# Inject right after lib/session.php require, which is the last lib/ load.
needle = "    require_once('../lib/session.php');"
if needle not in src:
    raise SystemExit("could not find lib/session.php require in cart/index.php")
inject = needle + "\n    require_once('../lib/page.php'); // workers-php: ensure pageError() is available"
src = src.replace(needle, inject, 1)
p.write_text(src)
PYEOF
	ok "cart/index.php patched"
fi

# ---------- 7. Patch AggregatorClause (empty clause list -> neutral boolean) ----------

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
# Upstream builds "()" when every sub-clause is null (e.g. /search/ with no
# min/max score or price params) — SQLite: near ")": syntax error. Emit the
# aggregation's neutral element instead so the clause is a no-op.
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

# ---------- 8. Normalise default-image filenames ----------
#
# The project ships default<N>.svg files for /assets/pictures/user/ and /dish/
# (varying), and a single default.svg for /menu/ and /restaurant/. Our
# missRewrite rule swaps <id>.webp -> default.svg uniformly, so we drop a
# copy of default0.svg as default.svg in the folders that lack it.

readonly PICTURES_DIR="${PROJECT_DIR}/assets/pictures"
for folder in user dish menu restaurant; do
	dst="${PICTURES_DIR}/${folder}/default.svg"
	if [[ -f "${dst}" ]]; then
		continue
	fi
	# Use default0.svg if available, otherwise the first match.
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
