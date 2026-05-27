# wasm/ — PHP-WASM runtime artifacts

These files are the PHP-WASM runtime imported by `src/index.ts`. They are
**built from source** by `build/build-php-wasm.sh`; see `../build/README.md`.

## Files

| File | Origin | Notes |
|---|---|---|
| `php-web.wasm`              | built  | PHP 8.5 compiled with `MAIN_MODULE=0 ASYNCIFY=1`. ~30 MB. |
| `php-web.mjs`               | built  | Emscripten loader for `php-web.wasm`. |
| `PhpBase.mjs`               | built  | Upstream wrapper base class, used as-is. |
| `OutputBuffer.mjs`          | built  | Upstream helper. |
| `_Event.mjs`                | built  | Upstream helper. |
| `fsOps.mjs`                 | built  | Upstream helper. |
| `resolveDependencies.mjs`   | built  | Upstream helper. |
| `PhpWeb.mjs`                | **hand-written** | Replaces the upstream version, which uses dynamic imports + `navigator.locks` (neither works in Cloudflare Workers). |
| `README.md`                 | doc    | This file. |

## Workers-compatibility invariants

The build script enforces these on every build:

```bash
grep -c 'new WebAssembly\.Module('  wasm/php-web.mjs   # must be 0
grep -c 'loadDylibs'                wasm/php-web.mjs   # must be 0
grep -c 'dynamicLibraries'          wasm/php-web.mjs   # must be 0
```

If any of these are nonzero, the build aborts and refuses to stage.

## Rebuilding

```bash
npm run build-wasm    # produces wasm/*.staged
npm run wasm-promote  # promotes *.staged → active, old → *.legacy
rm wasm/*.legacy      # once satisfied
```

To bump PHP version: edit `PHP_VERSION` in `build/build-php-wasm.sh` (default
`8.5`), then rebuild. To change extensions: edit `build/php-wasm.env`.
