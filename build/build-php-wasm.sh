#!/usr/bin/env bash
# Build a Cloudflare-Workers-compatible php-web.wasm + php-web.mjs.
#
# Stages artifacts as packages/workers-php/src/wasm/*.staged; run
# `npm run wasm-promote` after verifying them.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly BUILD_DIR="${REPO_ROOT}/build"
readonly CACHE_DIR="${REPO_ROOT}/.build-cache"
readonly UPSTREAM_REPO="https://github.com/seanmorris/php-wasm.git"
readonly UPSTREAM_DIR="${CACHE_DIR}/php-wasm"
readonly PHP_VERSION="${PHP_VERSION:-8.5}"
# EMSDK 3.1.74 is the newest version that builds php-wasm with the full
# extension set: EMSDK 4's wasm-ld no longer ignores the bare SONAME
# references (`libjpeg.so.9`, ...) that libtool emits in -shared mode, so
# all autotools-based third-party recipes fail to link.
#
# Upstream's "3.1.45+ broken (cloudflare)" bisect targeted MAIN_MODULE=1
# runtime compilation, which is dead code in a MAIN_MODULE=0 build.
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

# 1. Preflight

log "Preflight checks"

command -v git    >/dev/null || fail "git not found"
command -v docker >/dev/null || fail "docker not found"
docker compose version >/dev/null 2>&1 || fail "docker compose v2+ required"

mkdir -p "${CACHE_DIR}"
free_kb="$(df -Pk "${CACHE_DIR}" | awk 'NR==2 {print $4}')"
if (( free_kb < 5 * 1024 * 1024 )); then
	fail "Need ≥ 5 GB free under ${CACHE_DIR}; only $((free_kb / 1024)) MB available"
fi

if command -v free >/dev/null; then
	free_mem_kb="$(free -k | awk '/^Mem:/ {print $7}')"
	if (( free_mem_kb < 6 * 1024 * 1024 )); then
		warn "Free RAM is $((free_mem_kb / 1024)) MB; build may swap or OOM if under 6 GB"
	fi
fi

ok "Preflight passed"

# 2. Clone / fetch upstream

pinned_sha="$(tr -d '[:space:]' < "${BUILD_DIR}/pinned-commit.txt")"
[[ -n "${pinned_sha}" ]] || fail "build/pinned-commit.txt is empty"

if [[ -d "${UPSTREAM_DIR}/.git" ]]; then
	log "Found existing checkout at ${UPSTREAM_DIR}; fetching pinned commit"
	git -C "${UPSTREAM_DIR}" fetch --depth=1 origin "${pinned_sha}" 2>/dev/null \
		|| git -C "${UPSTREAM_DIR}" fetch origin
else
	log "Cloning ${UPSTREAM_REPO}"
	git clone --filter=blob:none "${UPSTREAM_REPO}" "${UPSTREAM_DIR}"
	git -C "${UPSTREAM_DIR}" fetch --depth=1 origin "${pinned_sha}" 2>/dev/null || true
fi

git -C "${UPSTREAM_DIR}" checkout --quiet "${pinned_sha}"
git -C "${UPSTREAM_DIR}" reset --hard --quiet "${pinned_sha}"
ok "Upstream checked out at ${pinned_sha}"

# 3. Overlay patched source files (before configure runs)

patches_dir="${BUILD_DIR}/patches"
if [[ -d "${patches_dir}" ]]; then
	if [[ -f "${patches_dir}/pib.c" ]]; then
		cp "${patches_dir}/pib.c" "${UPSTREAM_DIR}/source/pib/pib.c"
		# Also clobber the third_party copy, or mtime fools the next make.
		if [[ -f "${UPSTREAM_DIR}/third_party/php${PHP_VERSION}-src/ext/pib/pib.c" ]]; then
			cp "${patches_dir}/pib.c" "${UPSTREAM_DIR}/third_party/php${PHP_VERSION}-src/ext/pib/pib.c"
		fi
		ok "Overlaid patched pib.c (workers-php request-shutdown patch)"
	fi
fi

# 4. Pin EMSDK in the Dockerfile

dockerfile="${UPSTREAM_DIR}/emscripten-builder.dockerfile"
[[ -f "${dockerfile}" ]] || fail "Expected ${dockerfile} not found in upstream"

log "Pinning EMSDK version to ${EMSDK_VERSION} in upstream Dockerfile"
# Only the active ARG line is replaced; upstream's bisect comment stays.
sed -i.bak -E "s|^ARG EMSDK_VERSION=\".*\"$|ARG EMSDK_VERSION=\"${EMSDK_VERSION}\"|" "${dockerfile}"
if ! grep -qE "^ARG EMSDK_VERSION=\"${EMSDK_VERSION}\"$" "${dockerfile}"; then
	fail "Failed to pin EMSDK_VERSION in ${dockerfile}; manual inspection needed"
fi
ok "Dockerfile pinned to emscripten/emsdk:${EMSDK_VERSION}"

# 5. Remove the Emscripten fork override
#
# The upstream Dockerfile swaps the EMSDK's Emscripten for
# seanmorris/emscripten@sm-updates, whose wasm-ld flags (--initial-heap,
# --table-base) the pinned wasm-ld doesn't recognize — the configure
# compiler test fails.

log "Removing seanmorris/emscripten fork replacement from Dockerfile"
python3 - "${dockerfile}" <<'PYEOF'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# Replace the RUN block cloning the fork with a no-op comment.
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

# 6. Inject a corporate CA (hosts behind TLS inspection)
#
# Without the custom root CA inside the container, embuilder's HTTPS
# fetches fail with CERTIFICATE_VERIFY_FAILED.

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

	# Inject before `RUN embuilder build USER`, guarded by a marker.
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

# 7. Install the build env file

log "Installing build env at ${UPSTREAM_DIR}/.env"
cp "${BUILD_DIR}/php-wasm.env" "${UPSTREAM_DIR}/.env"
ok "Env file installed"

# 8. Inject extra configure flags into the Makefile
#
# fileinfo, mbstring, and the bundled bridge extension have no WITH_*
# knobs. The flags can't live in the .env (also read by docker compose,
# which rejects `+=`), so a line is appended to the Makefile directly.

if ! grep -qF "# php-wasm-worker: extra configure flags" "${UPSTREAM_DIR}/Makefile"; then
	log "Patching Makefile to add extra CONFIGURE_FLAGS"
	python3 - "${UPSTREAM_DIR}/Makefile" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
# Anchor: the final line of the env include block.
marker = "-include ${ENV_FILE}.${PHP_VERSION}\n"
inject = (
		"\n"
		"# php-wasm-worker: extra configure flags (no upstream knob for fileinfo)\n"
		"CONFIGURE_FLAGS+= --enable-fileinfo\n"
		"# php-wasm-worker: enable bundled extensions\n"
		"CONFIGURE_FLAGS+= --enable-workers-php-bridge\n"
		"# php-wasm-worker: PHP 8.5 configure does not recognise upstream's\n"
		"# --with-mbstring (silently skipped); the correct flag is --enable-mbstring.\n"
		"# oniguruma is then found via pkg-config from /src/lib (WITH_ONIGURUMA=static).\n"
		"CONFIGURE_FLAGS+= --enable-mbstring\n"
	)
if marker not in src:
	raise SystemExit(f"marker not found in Makefile: {marker!r}")
new = src.replace(marker, marker + inject, 1)
# The bridge's EM_ASYNC_JS uses stringToNewUTF8, which the upstream link
# line doesn't export as a runtime method.
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

# 9. Stage bundled PHP extensions
#
# Copied into ext/ before ./configure; the Makefile patch above adds the
# matching --enable flags.

bundled_extensions_dir="${BUILD_DIR}/extensions"
php_ext_root="${UPSTREAM_DIR}/third_party/php${PHP_VERSION}-src/ext"

if [[ -d "${bundled_extensions_dir}" ]]; then
	log "Staging bundled extensions from ${bundled_extensions_dir}"
	# third_party/php<ver>-src only exists after make downloads PHP, so
	# the extensions are stashed in UPSTREAM_DIR and a Makefile rule
	# (below) copies them into ext/ during the `patched` step.
	mkdir -p "${UPSTREAM_DIR}/build-extensions"
	for ext_dir in "${bundled_extensions_dir}"/*/; do
		[[ -d "${ext_dir}" ]] || continue
		name="$(basename "${ext_dir}")"
		rm -rf "${UPSTREAM_DIR}/build-extensions/${name}"
		cp -a "${ext_dir}" "${UPSTREAM_DIR}/build-extensions/${name}"
		ok "Staged extension: ${name}"
	done

	# The copy rule must land after the upstream PHP_CONFIGURE_DEPS=
	# reset (which wipes earlier `+=`), so it is injected right above
	# the configured: rule.
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

# This `+=` lands after the upstream reset and all static.mak `+=` lines,
# so it survives.
PHP_CONFIGURE_DEPS+= third_party/php{phpver}-src/bundled-extensions-staged

"""
# The marker is the literal (unexpanded) make-variable spelling of the
# configured: rule.
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

# 10. npm install in the upstream checkout
#
# The Makefile discovers sibling packages via `npm ls -p`; with missing
# deps it prints only the root, so no pre.mak files are included and
# `$(MAKE) ${PHP_CONFIGURE_DEPS}` becomes a bare `make` recursing into
# `all` — an infinite loop. --ignore-scripts avoids upstream's hooks,
# which would invoke Docker again.

log "Installing upstream workspace packages (npm install --ignore-scripts)"
( cd "${UPSTREAM_DIR}" && npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -20 )
ok "Workspace dependencies installed"

# 11. Build the Docker image

log "Building Docker image (first run: 10–20 min; cached afterwards)"
( cd "${UPSTREAM_DIR}" && make image )
ok "Docker image ready"

# 12. Build the wasm artifact

log "Building php${PHP_VERSION}-web.mjs + php${PHP_VERSION}-web.wasm (first run: 30–60 min)"
( cd "${UPSTREAM_DIR}" && make web-mjs PHP_VERSION="${PHP_VERSION}" )

artifact_mjs="${UPSTREAM_DIR}/packages/php-wasm/php${PHP_VERSION}-web.mjs"
# Upstream emits `${name}.mjs.wasm` (BUILD_TYPE=mjs); renamed on staging.
artifact_wasm="${UPSTREAM_DIR}/packages/php-wasm/php${PHP_VERSION}-web.mjs.wasm"
if [[ ! -f "${artifact_wasm}" ]]; then
	# Fall back to the conventional name if upstream changes it.
	alt="${UPSTREAM_DIR}/packages/php-wasm/php${PHP_VERSION}-web.wasm"
	[[ -f "${alt}" ]] && artifact_wasm="${alt}"
fi

[[ -f "${artifact_mjs}"  ]] || fail "Expected artifact missing: ${artifact_mjs}"
[[ -f "${artifact_wasm}" ]] || fail "Expected artifact missing: ${artifact_wasm}"
ok "Build produced ${artifact_mjs} and ${artifact_wasm}"

# 13. Finishing wasm-opt pass
#
# Upstream already ran -O3; a separate -Oz --converge pass shaves another
# ~50–100 KB gzip. --all-features is required for the bulk-memory and
# atomics intrinsics wasm-opt otherwise refuses. The result replaces the
# original only on success.

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

# 14. Sanity checks

log "Verifying Workers compatibility of php${PHP_VERSION}-web.mjs"

count_in_file() {
	# `|| true`: grep exits 1 on zero matches; the count is wanted, not
	# the exit status.
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

# 15. Stage artifacts
#
# The .staged suffix lets wasm-promote swap atomically. Upstream's
# PhpWeb.mjs does dynamic import() and navigator.locks — unusable on
# Workers — so the committed hand-written wasm/PhpWeb.mjs is kept and
# never staged.

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
