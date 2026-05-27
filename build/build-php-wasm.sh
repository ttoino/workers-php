#!/usr/bin/env bash
# Build a Cloudflare-Workers-compatible php-web.wasm + php-web.mjs from source.
#
# Outputs (staged side-by-side with the existing files; nothing destructive):
#   wasm/php<VERSION>-web.mjs
#   wasm/php<VERSION>-web.wasm
#
# After running this script and verifying the new artifacts work, run
#   npm run wasm-promote
# to swap them in as the canonical wasm/php-web.{mjs,wasm}.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly BUILD_DIR="${REPO_ROOT}/build"
readonly CACHE_DIR="${REPO_ROOT}/.build-cache"
readonly UPSTREAM_REPO="https://github.com/seanmorris/php-wasm.git"
readonly UPSTREAM_DIR="${CACHE_DIR}/php-wasm"
readonly PHP_VERSION="${PHP_VERSION:-8.5}"
# EMSDK 3.1.74 is the newest version that builds php-wasm successfully
# with the full extension set. EMSDK 4.x breaks all of upstream's autotools-
# based 3rd-party library recipes (libjpeg, libxml2, libyaml, ...) because
# EMSDK 4's wasm-ld no longer silently ignores bare SONAME references like
# `libjpeg.so.9` or `testdso.so` that libtool emits in -shared mode. EMSDK
# 3.1.x's emcc swallows those as "ignoring unsupported linker flag" warnings;
# EMSDK 4's passes them through and wasm-ld errors with "cannot open <name>:
# No such file or directory".
#
# Disabling only the image libs (jpeg/webp) is insufficient because the same
# issue hits libxml2 (and likely iconv, openssl, tidy, sqlite-autotools), which
# would force us to drop DOM/XML/XMLReader/XMLWriter/SimpleXML/Tidy too — a
# very stripped PHP. A real fix would patch each upstream package's static.mak
# to swap autotools for cmake-based equivalents, or to pre-create empty SONAME
# stubs before linking. Not worth it right now.
#
# Sean's bisect in upstream's Dockerfile labels EMSDK 3.1.45+ as "Broken
# (cloudflare)" but that targeted MAIN_MODULE=1 builds — the failure was
# runtime `new WebAssembly.Module(bytes)` paths Workers forbids, which are
# dead code with MAIN_MODULE=0.
readonly EMSDK_VERSION="${EMSDK_VERSION:-3.1.74}"

readonly C_BOLD=$'\033[1m'
readonly C_DIM=$'\033[2m'
readonly C_GREEN=$'\033[32m'
readonly C_YELLOW=$'\033[33m'
readonly C_RED=$'\033[31m'
readonly C_RESET=$'\033[0m'

log()  { printf "%s==>%s %s\n" "${C_BOLD}" "${C_RESET}" "$*" >&2; }
warn() { printf "%s==>%s %s\n" "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
fail() { printf "%sERROR:%s %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }
ok()   { printf "%s✓%s %s\n" "${C_GREEN}" "${C_RESET}" "$*" >&2; }

# ---------- Preflight ----------

log "Preflight checks"

command -v git    >/dev/null || fail "git not found"
command -v docker >/dev/null || fail "docker not found"
docker compose version >/dev/null 2>&1 || fail "docker compose v2+ required"

# Disk: require ≥ 5 GB free on the FS containing CACHE_DIR.
mkdir -p "${CACHE_DIR}"
free_kb="$(df -Pk "${CACHE_DIR}" | awk 'NR==2 {print $4}')"
if (( free_kb < 5 * 1024 * 1024 )); then
	fail "Need ≥ 5 GB free under ${CACHE_DIR}; only $((free_kb / 1024)) MB available"
fi

# RAM: warn if < 6 GB free.
if command -v free >/dev/null; then
	free_mem_kb="$(free -k | awk '/^Mem:/ {print $7}')"
	if (( free_mem_kb < 6 * 1024 * 1024 )); then
		warn "Free RAM is $((free_mem_kb / 1024)) MB; build may swap or OOM if under 6 GB"
	fi
fi

ok "Preflight passed"

# ---------- Clone / fetch upstream ----------

pinned_sha="$(tr -d '[:space:]' < "${BUILD_DIR}/pinned-commit.txt")"
[[ -n "${pinned_sha}" ]] || fail "build/pinned-commit.txt is empty"

if [[ -d "${UPSTREAM_DIR}/.git" ]]; then
	log "Found existing checkout at ${UPSTREAM_DIR}; fetching pinned commit"
	git -C "${UPSTREAM_DIR}" fetch --depth=1 origin "${pinned_sha}" 2>/dev/null \
		|| git -C "${UPSTREAM_DIR}" fetch origin
else
	log "Cloning ${UPSTREAM_REPO}"
	git clone --filter=blob:none "${UPSTREAM_REPO}" "${UPSTREAM_DIR}"
	# Reset to pinned SHA after clone.
	git -C "${UPSTREAM_DIR}" fetch --depth=1 origin "${pinned_sha}" 2>/dev/null || true
fi

git -C "${UPSTREAM_DIR}" checkout --quiet "${pinned_sha}"
git -C "${UPSTREAM_DIR}" reset --hard --quiet "${pinned_sha}"
ok "Upstream checked out at ${pinned_sha}"

# ---------- Patch Dockerfile to pin EMSDK ----------

dockerfile="${UPSTREAM_DIR}/emscripten-builder.dockerfile"
[[ -f "${dockerfile}" ]] || fail "Expected ${dockerfile} not found in upstream"

log "Pinning EMSDK version to ${EMSDK_VERSION} in upstream Dockerfile"
# Sean's bisect comments call EMSDK 3.1.43/3.1.44 Cloudflare-compatible; 3.1.45+ broken.
# We replace the active `ARG EMSDK_VERSION=...` line, leaving the comment block intact.
sed -i.bak -E "s|^ARG EMSDK_VERSION=\".*\"$|ARG EMSDK_VERSION=\"${EMSDK_VERSION}\"|" "${dockerfile}"
if ! grep -qE "^ARG EMSDK_VERSION=\"${EMSDK_VERSION}\"$" "${dockerfile}"; then
	fail "Failed to pin EMSDK_VERSION in ${dockerfile}; manual inspection needed"
fi
ok "Dockerfile pinned to emscripten/emsdk:${EMSDK_VERSION}"

# ---------- Remove Sean's Emscripten fork override ----------
#
# Upstream Dockerfile replaces the EMSDK's bundled Emscripten with a clone of
# seanmorris/emscripten@sm-updates. That fork (as of late 2024) emits
# wasm-ld flags (`--initial-heap`, `--table-base`) that EMSDK 3.1.43's
# 2023-era wasm-ld doesn't recognize, breaking the configure compiler test.
#
# We keep the stock Emscripten that ships with EMSDK 3.1.43.

log "Removing seanmorris/emscripten fork replacement from Dockerfile"
python3 - "${dockerfile}" <<'PYEOF'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# Match the RUN block that clones seanmorris/emscripten, replacing it with a no-op.
pattern = re.compile(
	r"RUN cd /emsdk/upstream && \{\\?\s*\n"
	r"(?:.*?\\\n)+?"
	r"\}\n",
	re.MULTILINE,
)
new, n = pattern.subn(
	"# php-wasm-worker: skipped seanmorris/emscripten fork replacement "
	"(incompatible wasm-ld flags vs EMSDK 3.1.43)\n",
	src,
	count=1,
)
if n != 1:
	raise SystemExit("Could not find seanmorris/emscripten replacement block in Dockerfile")
p.write_text(new)
PYEOF
ok "Stock EMSDK Emscripten kept"

# ---------- Inject corporate CA into Docker image (for hosts behind SSL inspection) ----------
#
# Hosts behind a TLS-inspecting proxy (e.g. Cloudflare WARP zero-trust) need
# their custom root CA installed inside the container, otherwise Emscripten's
# `embuilder build USER` step fails with `CERTIFICATE_VERIFY_FAILED` when it
# fetches Emscripten ports over HTTPS.

corporate_ca_src=""
for candidate in \
	"${CORPORATE_CA_FILE:-}" \
	"${SSL_CERT_FILE:-}" \
	"${REQUESTS_CA_BUNDLE:-}" \
	"${NODE_EXTRA_CA_CERTS:-}" \
; do
	if [[ -n "${candidate}" && -f "${candidate}" ]]; then
		corporate_ca_src="${candidate}"
		break
	fi
done

corporate_ca_dst="${UPSTREAM_DIR}/corporate-ca.pem"
if [[ -n "${corporate_ca_src}" ]]; then
	log "Injecting corporate CA bundle from ${corporate_ca_src}"
	cp -f "${corporate_ca_src}" "${corporate_ca_dst}"

	# Insert the CA install steps before `RUN embuilder build USER`. Idempotent:
	# we only inject if the marker line isn't already present.
	if ! grep -qF "# php-wasm-worker: inject corporate CA" "${dockerfile}"; then
		python3 - "${dockerfile}" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
marker = "RUN embuilder build USER"
inject = (
	"# php-wasm-worker: inject corporate CA\n"
	"COPY corporate-ca.pem /usr/local/share/ca-certificates/corporate-ca.crt\n"
	"RUN update-ca-certificates\n"
	"ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\n"
	"ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt\n"
	"\n"
)
if marker not in src:
	raise SystemExit(f"marker not found: {marker!r}")
new = src.replace(marker, inject + marker, 1)
p.write_text(new)
PYEOF
	fi
	ok "Corporate CA wired into Docker image"
else
	log "No corporate CA detected (CORPORATE_CA_FILE/SSL_CERT_FILE unset); skipping"
fi

# ---------- Drop our env file into the checkout ----------

log "Installing build env at ${UPSTREAM_DIR}/.env"
cp "${BUILD_DIR}/php-wasm.env" "${UPSTREAM_DIR}/.env"
ok "Env file installed"

# ---------- Patch Makefile to inject extra configure flags ----------
#
# Upstream's php-wasm has no `WITH_FILEINFO` knob, but Laravel's UploadedFile
# requires `ext-fileinfo`. PHP's fileinfo extension lives in PHP core
# (ext/fileinfo), so a single `--enable-fileinfo` on configure is enough.
#
# We can't put `CONFIGURE_FLAGS+= --enable-fileinfo` in our .env because that
# file is also consumed by `docker compose build`, which rejects make's `+=`
# operator. Instead we append a line directly to the Makefile, right after
# the env include, so it runs in the same phase. Idempotent.

if ! grep -qF "# php-wasm-worker: extra configure flags" "${UPSTREAM_DIR}/Makefile"; then
	log "Patching Makefile to add extra CONFIGURE_FLAGS"
	python3 - "${UPSTREAM_DIR}/Makefile" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# Insert just after the first env include block (line ~22-30). Anchor on the
# `-include ${ENV_FILE}.${PHP_VERSION}` line which sits at the end of that block.
marker = "-include ${ENV_FILE}.${PHP_VERSION}\n"
inject = (
	"\n"
	"# php-wasm-worker: extra configure flags (no upstream knob for fileinfo)\n"
	"CONFIGURE_FLAGS+= --enable-fileinfo\n"
	"# php-wasm-worker: enable bundled extensions\n"
	"CONFIGURE_FLAGS+= --enable-workers-php-bridge\n"
)
if marker not in src:
	raise SystemExit(f"marker not found in Makefile: {marker!r}")
new = src.replace(marker, marker + inject, 1)
# The workers_php_bridge extension's EM_ASYNC_JS code uses
# `stringToNewUTF8` and the upstream Emscripten link line doesn't export
# it as a JS runtime method. Add it (idempotent).
old_exports = '"ccall", "UTF8ToString", "lengthBytesUTF8", "stringToUTF8", "getValue", "setValue", "lengthBytesUTF8", "FS", "ENV"'
new_exports = '"ccall", "UTF8ToString", "lengthBytesUTF8", "stringToUTF8", "stringToNewUTF8", "getValue", "setValue", "lengthBytesUTF8", "FS", "ENV"'
if old_exports in new:
	new = new.replace(old_exports, new_exports, 1)
elif new_exports not in new:
	raise SystemExit("EXPORTED_RUNTIME_METHODS marker not found; upstream may have changed it")
p.write_text(new)
PYEOF
	ok "Makefile patched"
else
	ok "Makefile already patched"
fi

# ---------- Copy bundled PHP extensions into the upstream checkout ----------
#
# We ship a few small PHP extensions in build/extensions/. They get copied
# into third_party/php<ver>-src/ext/<name>/ before `./configure` so PHP's
# build system picks them up. The Makefile patch above adds the
# corresponding `--enable-<name>` flags.

bundled_extensions_dir="${BUILD_DIR}/extensions"
php_ext_root="${UPSTREAM_DIR}/third_party/php${PHP_VERSION}-src/ext"

if [[ -d "${bundled_extensions_dir}" ]]; then
	log "Staging bundled extensions from ${bundled_extensions_dir}"
	# The third_party/php<ver>-src directory only exists after the PHP
	# source has been downloaded and unpacked. The Makefile creates it
	# during the first `make` invocation. We can't copy yet — defer until
	# the source is in place by writing a sentinel shell snippet the
	# Makefile's PHP-source-patched target invokes. The simpler trick used
	# here: stash the extensions in a known location inside UPSTREAM_DIR
	# and add a Makefile rule that copies them into ext/ as part of the
	# `patched` step.
	mkdir -p "${UPSTREAM_DIR}/build-extensions"
	# Mirror each extension subdir.
	for ext_dir in "${bundled_extensions_dir}"/*/; do
		[[ -d "${ext_dir}" ]] || continue
		name="$(basename "${ext_dir}")"
		rm -rf "${UPSTREAM_DIR}/build-extensions/${name}"
		cp -a "${ext_dir}" "${UPSTREAM_DIR}/build-extensions/${name}"
		ok "Staged extension: ${name}"
	done

	# Patch the Makefile to add a rule that copies our extensions into
	# the PHP source tree before `./configure` runs. The injection has to
	# happen AFTER the `PHP_CONFIGURE_DEPS=` reset line near the top of
	# the upstream Makefile (which wipes any earlier `+=`), so we anchor
	# on the `third_party/php${PHP_VERSION}-src/configured:` rule and
	# inject right above it.
	if ! grep -qF "# php-wasm-worker: copy bundled extensions" "${UPSTREAM_DIR}/Makefile"; then
		python3 - "${UPSTREAM_DIR}/Makefile" "${PHP_VERSION}" <<'PYEOF'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
phpver = sys.argv[2]
src = p.read_text()
inject = f"""
# php-wasm-worker: copy bundled extensions into the PHP source tree.
# Runs after `patched` and before `configured`. Both the `cp` and the
# final marker `touch` are run inside docker because the PHP source tree
# is owned by the container's root uid; touching it from the host fails.
third_party/php{phpver}-src/bundled-extensions-staged: third_party/php{phpver}-src/patched
\t@ echo "==> Staging bundled extensions into third_party/php{phpver}-src/ext/"
\t@ for d in build-extensions/*/; do \\
\t\t[ -d "$$d" ] || continue; \\
\t\tname="$$(basename $$d)"; \\
\t\t${{DOCKER_RUN}} cp -a build-extensions/$$name third_party/php{phpver}-src/ext/$$name; \\
\tdone
\t${{DOCKER_RUN}} touch $@

# Wire the new target into the existing `configured` rule by adding it as
# a dependency through PHP_CONFIGURE_DEPS. This `+=` lands AFTER the
# upstream `PHP_CONFIGURE_DEPS=` reset and AFTER all the per-package
# static.mak `+=` lines, so it survives.
PHP_CONFIGURE_DEPS+= third_party/php{phpver}-src/bundled-extensions-staged

"""
# Anchor on the configured: rule. In the upstream Makefile this is
# spelled `third_party/php${PHP_VERSION}-src/configured:` (literal make
# variable, not yet expanded). Find that.
marker = "third_party/php${PHP_VERSION}-src/configured:"
idx = src.find(marker)
if idx < 0:
	raise SystemExit(f"marker not found: {marker!r}")
new = src[:idx] + inject + src[idx:]
p.write_text(new)
PYEOF
		ok "Makefile patched to stage bundled extensions"
	else
		ok "Makefile bundled-extensions rule already present"
	fi
else
	log "No build/extensions/ directory; skipping bundled extensions"
fi

# ---------- npm install in the upstream checkout ----------
#
# The Makefile uses `$(shell npm ls -p)` to discover sibling packages and
# then `-include`s their pre.mak/static.mak files. When npm has missing
# dependencies, `npm ls -p` only prints the checkout root, the package
# pre.mak files aren't included, PHP_CONFIGURE_DEPS stays empty, and the
# `$(MAKE) ${PHP_CONFIGURE_DEPS}` line in `web-mjs` becomes a bare `make`
# which recurses into the `all` target — infinite loop. Running
# `npm install --ignore-scripts` populates the workspace so `npm ls -p`
# resolves correctly. We skip lifecycle scripts to avoid running upstream's
# build hooks that would invoke Docker again.

log "Installing upstream workspace packages (npm install --ignore-scripts)"
( cd "${UPSTREAM_DIR}" && npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -20 )
ok "Workspace dependencies installed"

# ---------- Build the Docker image ----------

log "Building Docker image (first run: 10–20 min; cached afterwards)"
( cd "${UPSTREAM_DIR}" && make image )
ok "Docker image ready"

# ---------- Build the wasm artifact ----------

log "Building php${PHP_VERSION}-web.mjs + php${PHP_VERSION}-web.wasm (first run: 30–60 min)"
( cd "${UPSTREAM_DIR}" && make web-mjs PHP_VERSION="${PHP_VERSION}" )

artifact_mjs="${UPSTREAM_DIR}/packages/php-wasm/php${PHP_VERSION}-web.mjs"
# Upstream emits the wasm as `${name}.mjs.wasm` (Emscripten's BUILD_TYPE=mjs);
# we rename to `${name}.wasm` when staging.
artifact_wasm="${UPSTREAM_DIR}/packages/php-wasm/php${PHP_VERSION}-web.mjs.wasm"
if [[ ! -f "${artifact_wasm}" ]]; then
	# Fallback to the conventional name in case upstream changes it.
	alt="${UPSTREAM_DIR}/packages/php-wasm/php${PHP_VERSION}-web.wasm"
	[[ -f "${alt}" ]] && artifact_wasm="${alt}"
fi

[[ -f "${artifact_mjs}"  ]] || fail "Expected artifact missing: ${artifact_mjs}"
[[ -f "${artifact_wasm}" ]] || fail "Expected artifact missing: ${artifact_wasm}"
ok "Build produced ${artifact_mjs} and ${artifact_wasm}"

# ---------- Finishing wasm-opt pass ----------
#
# Upstream's build already runs `wasm-opt -O3` on the artifact, but doing
# a separate `-Oz --converge` pass with the right feature flags shaves
# another small chunk (~50–100 KB gzip in practice) by re-running size-first
# optimizations until they stop helping. `--all-features` is required because
# the wasm uses bulk-memory and atomics intrinsics that wasm-opt defaults
# to refusing without explicit feature flags.
#
# The pass writes a new file then renames over the original so a failure
# leaves the upstream artifact intact.

log "Running finishing wasm-opt -Oz --converge pass"
artifact_size_before=$(stat -c %s "${artifact_wasm}")
docker run --rm \
	-v "${UPSTREAM_DIR}:/src" \
	seanmorris/php-emscripten-builder:latest \
	/emsdk/upstream/bin/wasm-opt \
		--all-features \
		-Oz \
		--converge \
		"/src/packages/php-wasm/$(basename "${artifact_wasm}")" \
		-o "/src/packages/php-wasm/$(basename "${artifact_wasm}").opt"

if [[ -f "${artifact_wasm}.opt" ]]; then
	artifact_size_after=$(stat -c %s "${artifact_wasm}.opt")
	mv -f "${artifact_wasm}.opt" "${artifact_wasm}"
	delta=$(( artifact_size_before - artifact_size_after ))
	if (( delta > 0 )); then
		ok "wasm-opt saved ${delta} bytes ($(( delta / 1024 )) KB raw) — $(stat -c %s "${artifact_wasm}") B final"
	else
		warn "wasm-opt produced a larger file ($(( -delta )) bytes); keeping anyway"
	fi
else
	fail "wasm-opt pass did not produce ${artifact_wasm}.opt"
fi

# ---------- Sanity checks ----------

log "Verifying Workers compatibility of php${PHP_VERSION}-web.mjs"

count_in_file() {
	# grep -c counts matching lines; pcre to span call sites without newlines.
	# `|| true` keeps pipefail+errexit from killing us when grep finds 0 matches
	# (exit 1) — we want the count, not the exit status.
	local pat="$1" file="$2"
	{ grep -oE "${pat}" "${file}" 2>/dev/null || true; } | wc -l | tr -d ' '
}

bad=0
n_module="$(count_in_file 'new WebAssembly\.Module\(' "${artifact_mjs}")"
if [[ "${n_module}" != "0" ]]; then
	fail "${artifact_mjs} contains ${n_module} runtime WebAssembly.Module compilation(s); incompatible with Cloudflare Workers."
fi
ok "No runtime WebAssembly.Module(bytes) calls"

n_dylib="$(count_in_file 'loadDylibs' "${artifact_mjs}")"
if [[ "${n_dylib}" != "0" ]]; then
	warn "${artifact_mjs} contains ${n_dylib} loadDylibs reference(s); MAIN_MODULE may not be 0"
	bad=1
else
	ok "No loadDylibs references"
fi

n_dynlib="$(count_in_file 'dynamicLibraries' "${artifact_mjs}")"
if [[ "${n_dynlib}" != "0" ]]; then
	warn "${artifact_mjs} contains ${n_dynlib} dynamicLibraries reference(s); MAIN_MODULE may not be 0"
	bad=1
else
	ok "No dynamicLibraries references"
fi

if [[ "${bad}" != "0" ]]; then
	fail "Artifact failed Workers-compat checks; refusing to stage"
fi

wasm_size_mb=$(( $(stat -c %s "${artifact_wasm}") / 1024 / 1024 ))
log "Artifact sizes: $(du -h "${artifact_mjs}" | cut -f1) mjs, ${wasm_size_mb} MB wasm"

# ---------- Stage everything under versioned/staged names ----------
#
# The full set of files written by upstream `make web-mjs` is:
#   - php<VER>-web.mjs       (Emscripten loader)
#   - php<VER>-web.mjs.wasm  (the wasm binary)
#   - PhpBase.mjs            (PHP wrapper base class)
#   - PhpWeb.mjs             (web subclass — we override this; see below)
#   - OutputBuffer.mjs, _Event.mjs, fsOps.mjs, resolveDependencies.mjs, webTransactions.mjs
#
# We stage them with a `.staged` suffix so the promote step can swap them
# atomically. PhpWeb.mjs upstream does dynamic `import()` per PHP version and
# uses `navigator.locks.request` — neither works in Cloudflare Workers. We
# keep our hand-written wasm/PhpWeb.mjs (committed; not overwritten by build).

readonly STAGE_DIR="${REPO_ROOT}/packages/workers-php/src/wasm"

stage_one() {
	local src="$1" name="$2"
	local dst="${STAGE_DIR}/${name}.staged"
	cp -f "${src}" "${dst}"
	echo "  staged: ${name}.staged"
}

log "Staging artifacts under ${STAGE_DIR}/*.staged"
stage_one "${artifact_mjs}"                                                   "php-web.mjs"
stage_one "${artifact_wasm}"                                                  "php-web.wasm"
stage_one "${UPSTREAM_DIR}/packages/php-wasm/PhpBase.mjs"                     "PhpBase.mjs"
stage_one "${UPSTREAM_DIR}/packages/php-wasm/OutputBuffer.mjs"                "OutputBuffer.mjs"
stage_one "${UPSTREAM_DIR}/packages/php-wasm/_Event.mjs"                      "_Event.mjs"
stage_one "${UPSTREAM_DIR}/packages/php-wasm/fsOps.mjs"                       "fsOps.mjs"
stage_one "${UPSTREAM_DIR}/packages/php-wasm/resolveDependencies.mjs"         "resolveDependencies.mjs"
ok "Staged php${PHP_VERSION} artifacts"

# ---------- Done ----------

cat >&2 <<EOF

${C_BOLD}Build complete.${C_RESET}

Staged files (under wasm/):
  ${C_DIM}php-web.mjs.staged${C_RESET}              php${PHP_VERSION} Emscripten loader
  ${C_DIM}php-web.wasm.staged${C_RESET}             php${PHP_VERSION} binary
  ${C_DIM}PhpBase.mjs.staged${C_RESET}              upstream wrapper base
  ${C_DIM}OutputBuffer.mjs.staged${C_RESET}         upstream helper
  ${C_DIM}_Event.mjs.staged${C_RESET}               upstream helper
  ${C_DIM}fsOps.mjs.staged${C_RESET}                upstream helper
  ${C_DIM}resolveDependencies.mjs.staged${C_RESET}  upstream helper

To verify before promoting, point src/index.ts at the .staged files temporarily,
or just trust the Workers-compat check that already passed. To promote:
  ${C_BOLD}npm run wasm-promote${C_RESET}

EOF
