# Building PHP-WASM from source

This directory holds the configuration and scripts used to compile a
Cloudflare-Workers-compatible build of PHP-WASM from
[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm).

The output of the build replaces `wasm/php-web.mjs` and `wasm/php-web.wasm`.

## Why we don't use the npm `php-wasm` package

The published `php-wasm@0.1.0` artifacts on npm are built with
`MAIN_MODULE=1` (dynamic linking). That causes Emscripten to embed runtime
WebAssembly compilation calls (`new WebAssembly.Module(bytes)`,
`addFunction` → `convertJsFunctionToWasm`) which Cloudflare Workers
[explicitly forbids](https://developers.cloudflare.com/workers/runtime-apis/web-standards/#javascript-standards).

This build overrides the upstream defaults with `MAIN_MODULE=0` (static
linking), eliminating all forbidden APIs while keeping `ASYNCIFY=1` for
PHP feature parity. The Dockerfile is also pinned to EMSDK 3.1.43, the
last version Sean's own bisect labels as Cloudflare-compatible.

## Files

| File | Purpose |
|---|---|
| `build-php-wasm.sh` | Clones upstream, patches, runs `make web-mjs`, sanity-checks the output, stages all upstream-built files into `wasm/*.staged`. |
| `promote-wasm.sh`   | After manual verification, moves the staged files into their canonical slots in `wasm/`, backing up the previous active files as `wasm/*.legacy`. |
| `php-wasm.env`      | Build-flag overrides consumed by upstream's `Makefile` via its `.env` include. |
| `pinned-commit.txt` | Upstream SHA we built against. Bump this to upgrade. |

## Patches applied to the upstream checkout

`build-php-wasm.sh` patches `emscripten-builder.dockerfile` in two places:

1. **Pin EMSDK** to `3.1.43` (the last version Sean's bisect labels as
   Cloudflare-compatible — see comments at the top of upstream's Dockerfile).
2. **Remove the seanmorris/emscripten fork replacement.** Upstream replaces
   the stock EMSDK Emscripten with a fork from late 2024 that emits
   `wasm-ld` flags (`--initial-heap`, `--table-base`) that the 2023-era
   `wasm-ld` shipped in EMSDK 3.1.43 doesn't recognize.
3. **Inject corporate root CA** (if `SSL_CERT_FILE` etc. are set) so the
   container's HTTPS fetches work behind TLS-inspecting proxies like
   Cloudflare WARP zero-trust.

## Files we replace / don't promote

The upstream build also produces `PhpWeb.mjs`, but we keep our own
hand-written `wasm/PhpWeb.mjs`. Upstream's version does dynamic
`import(\`./phpX.Y-web.mjs\`)` switch-cases per PHP version (esbuild can't
bundle those) and calls `navigator.locks.request` which doesn't exist in
the Cloudflare Workers runtime. Our replacement just imports the single
`php-web.mjs` we ship and stubs the lock/transaction methods.

## Requirements

- Docker (≥ Compose v2)
- ~5 GB free disk under the repo root (for `.build-cache/`)
- ~6 GB free RAM at link time
- First build: 30–60 min wall time. Subsequent builds: 5–15 min.

## Usage

```bash
# Build everything from source into wasm/*.staged
npm run build-wasm

# Test if you want — the staged files don't yet replace the active ones.
# (Easiest: change a *.staged filename or symlink temporarily.)

# Promote: rename wasm/*.staged → wasm/*, backing up old ones as wasm/*.legacy
npm run wasm-promote

# When satisfied with the new files, clean up the legacy backups:
rm wasm/*.legacy
```

## Configuration knobs

Set as environment variables on the `npm run build-wasm` invocation:

| Variable | Default | Notes |
|---|---|---|
| `PHP_VERSION`   | `8.5`    | One of `8.0` … `8.5`. |
| `EMSDK_VERSION` | `3.1.74` | Newest EMSDK 3.1.x that successfully builds php-wasm with `MAIN_MODULE=0`. See note below. |

### Note on EMSDK versions

Sean's upstream Dockerfile comments label EMSDK 3.1.45+ as "Broken (cloudflare)",
but that bisect targeted `MAIN_MODULE=1` builds — the breakage was the
runtime `new WebAssembly.Module(bytes)` call paths Cloudflare Workers forbids,
all of which are dead code when `MAIN_MODULE=0`.

Tested:

- **EMSDK 3.1.43**: works (the original Cloudflare-safe pin).
- **EMSDK 3.1.74**: works (current default). Slightly smaller / faster output.
- **EMSDK 4.0.23**: does **not** work. `wasm-ld` in EMSDK 4 no longer
  silently ignores bare SONAME references like `libjpeg.so.9` or `testdso.so`
  that autotools libtool emits in `-shared` mode. EMSDK 3.1.x's `emcc`
  translates those into "ignoring unsupported linker flag" warnings; EMSDK
  4's `emcc` passes them through and `wasm-ld` errors with `cannot open
  <name>: No such file or directory`.

  This breaks **every autotools-based 3rd-party library** upstream `php-wasm`
  builds, not just the image codecs: libxml2 (gates DOM/XML/SimpleXML/
  XMLReader/XMLWriter), libjpeg, libwebp, iconv, openssl, tidy, libyaml.
  Disabling just the image libs is insufficient; the next failure is
  libxml2's `testdso.so` build helper.

  Real fixes would either (a) patch each upstream package's `static.mak` to
  pre-create empty SONAME stub files before linking, (b) replace the
  affected autotools recipes with cmake-based equivalents (e.g. libjpeg-turbo),
  or (c) wait for upstream php-wasm to migrate. Not currently worth it.

Newer EMSDK 3.1.x versions between `.74` and the latest `.7x` series may
also work but weren't tested.

To change the extension set (`WITH_BCMATH`, `WITH_LIBZIP`, etc.), edit
`build/php-wasm.env`. PHP `./configure` flags that have no `WITH_*` knob
upstream (e.g. `--enable-fileinfo`) are injected by `build-php-wasm.sh`
itself, which patches the upstream Makefile right after the env include.

After the upstream `make web-mjs` produces the wasm, `build-php-wasm.sh`
runs a finishing `wasm-opt --all-features -Oz --converge` pass that
shaves off another ~0.8 MB raw / ~60-250 KB gzipped depending on the
extension set.

## Verifying a build is Workers-compatible

The build script runs these automatically; if you ever build by hand, run
them yourself:

```bash
# All three must be 0.
grep -oE 'new WebAssembly\.Module\(' wasm/php-web.mjs | wc -l
grep -c   'loadDylibs'                wasm/php-web.mjs
grep -c   'dynamicLibraries'          wasm/php-web.mjs
```

## Reproducibility

The build is pinned to:
- Upstream commit: see `pinned-commit.txt`
- EMSDK version: see `EMSDK_VERSION` in `build-php-wasm.sh`
- PHP version: see `PHP_VERSION` in `build-php-wasm.sh`

Two clean checkouts with the same pins should produce identical wasm
binaries modulo timestamps embedded in `.mjs` source map paths.
