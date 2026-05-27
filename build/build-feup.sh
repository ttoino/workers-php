#!/usr/bin/env bash
# Prepare ./feup-ltw-proj for bundling with workers-php:
#
#   1. Build main.db from the project's SQLite schema (the upstream repo
#      ships a shell script `database/createdb` that does this with the
#      sqlite3 CLI).
#   2. Copy our Apache-style router.php into the project root.
#   3. Patch lib/session.php to honour HTTPS-or-not for cookie_secure,
#      so `wrangler dev` over plain HTTP can keep sessions.
#
# All edits are idempotent and confined to the gitignored project clone.
# Subsequent steps (workers-php build, wrangler dev/deploy) live in
# package.json scripts.

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

command -v sqlite3 >/dev/null \
	|| fail "sqlite3 CLI not found on PATH. Install it (apt: 'sqlite3', brew: 'sqlite')."

# ---------- 1. Build main.db ----------

readonly SCHEMA_DIR="${PROJECT_DIR}/database/schema"
# database/models/model.php hardcodes the DB location as
# `dirname(__DIR__).'/main.db'` from database/models/, which resolves to
# database/main.db. The upstream `database/createdb` shell script writes
# there too (it cds into database/ and runs `sqlite3 main.db`). We match.
readonly DB_PATH="${PROJECT_DIR}/database/main.db"

for f in create.sql triggers.sql populate.sql; do
	[[ -f "${SCHEMA_DIR}/${f}" ]] || fail "Missing schema file: ${SCHEMA_DIR}/${f}"
done

# Clean up any DB file the previous (buggy) version of this script wrote at
# the project root.
rm -f "${PROJECT_DIR}/main.db"

log "Building ${DB_PATH} from ${SCHEMA_DIR}/"
rm -f "${DB_PATH}"
sqlite3 "${DB_PATH}" < "${SCHEMA_DIR}/create.sql"
sqlite3 "${DB_PATH}" < "${SCHEMA_DIR}/triggers.sql"
sqlite3 "${DB_PATH}" < "${SCHEMA_DIR}/populate.sql"

# Sanity: at least one row in Restaurant.
row_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM Restaurant;")"
ok "main.db built ($(stat -c %s "${DB_PATH}") bytes, ${row_count} restaurants)"

# ---------- 2. Overlay router.php ----------

log "Installing router.php into ${PROJECT_DIR}/"
cp "${OVERLAY_DIR}/router.php" "${PROJECT_DIR}/router.php"
ok "router.php installed"

# ---------- 3. Patch lib/session.php for HTTP local dev ----------
#
# Replace the hardcoded `'cookie_secure' => '1'` with a conditional that
# only sets it when the request actually arrived over HTTPS. Without this,
# Chrome/Firefox refuse to send the session cookie back to wrangler dev's
# plain-HTTP localhost, breaking login/cart/etc. locally.

readonly SESSION_FILE="${PROJECT_DIR}/lib/session.php"
[[ -f "${SESSION_FILE}" ]] || fail "Missing ${SESSION_FILE}"

if grep -qF "// workers-php: cookie_secure made conditional" "${SESSION_FILE}"; then
	# Rewrite anyway in case the earlier patch had a bug.
	log "Re-patching ${SESSION_FILE} (cookie_secure)"
else
	log "Patching ${SESSION_FILE} (cookie_secure -> conditional on HTTPS)"
fi

python3 - "${SESSION_FILE}" <<'PYEOF'
import sys, pathlib, re
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

# ---------- 4. Patch templates/form.php to use urlencoded forms ----------
#
# workers-php's CGI prelude parses `application/x-www-form-urlencoded`
# POST bodies into $_POST but does NOT yet parse `multipart/form-data`.
# The project's createForm() helper hardcodes `enctype="multipart/form-data"`,
# which means every POST (login, register, review, place_order, …) lands
# in PHP with an empty $_POST. Flipping the enctype lets all non-upload
# forms work. Image-upload endpoints remain broken (no $_FILES) but they
# need GD post-processing anyway and are accepted as broken in this v1.

readonly FORM_FILE="${PROJECT_DIR}/templates/form.php"
[[ -f "${FORM_FILE}" ]] || fail "Missing ${FORM_FILE}"

if grep -qF "workers-php: switched to urlencoded" "${FORM_FILE}"; then
	ok "form.php already patched"
else
	log "Patching ${FORM_FILE} (multipart/form-data -> application/x-www-form-urlencoded)"
	python3 - "${FORM_FILE}" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
needle = 'enctype="multipart/form-data"'
# Marker is in a PHP comment so it's invisible to the rendered HTML.
replacement = (
    'enctype="application/x-www-form-urlencoded"'
    ' <?php /* workers-php: switched to urlencoded; multipart parsing not yet supported */ ?>'
)
if needle not in src:
    raise SystemExit(f"could not find needle in {sys.argv[1]!r}: {needle!r}")
new = src.replace(needle, replacement, 1)
p.write_text(new)
PYEOF
	ok "form.php patched"
fi

echo
ok "feup-ltw-proj is ready to bundle. Next:"
echo "    npx workers-php build ${PROJECT_DIR} \\"
echo "        --out ${REPO_ROOT}/dist-feup \\"
echo "        --docroot . --entrypoint router.php"
