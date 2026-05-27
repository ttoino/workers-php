# php-wasm-worker

Monorepo containing the **[`workers-php`](packages/workers-php)** library —
which lets you run a PHP project on Cloudflare Workers, with the project
code stored in the Workers ASSETS binding — plus a demo Worker that
exercises it.

## Layout

```
packages/workers-php/    The library. See packages/workers-php/README.md.
build/                   Scripts that compile the PHP wasm artifact from
                         seanmorris/php-wasm. See build/README.md.
src/index.ts             Demo Worker, ~10 lines, consumes the library.
php/                     Demo PHP project (tiny front controller + a few pages).
wrangler.jsonc           Wrangler config wired up for the ASSETS-backed flow.
```

## Run the demo locally

```bash
npm install
npm run build-php          # bundles ./php into ./dist/app.tar.gz
npx wrangler dev           # serve at http://localhost:8787
```

Routes:

- `/` — landing page
- `/info` — `phpinfo()`
- `/hello?name=...` — query-string demo
- `/check` — PHP extensions / Laravel-requirements diagnostic
- everything else — 404 from the PHP router

## Rebuild the PHP wasm

The PHP wasm runtime is vendored under
`packages/workers-php/src/wasm/`. Rebuilding it from source requires
Docker:

```bash
npm run build-wasm          # ~30 min, see build/README.md
npm run wasm-promote        # atomically swap *.staged → active
rm packages/workers-php/src/wasm/*.legacy  # when satisfied
```

## Run tests

```bash
npm test                   # vitest, runs inside the @cloudflare/vitest-pool-workers runtime
```

## What's where

- **Worker bundle size**: ~8.7 MB gzipped (the PHP wasm dominates). Fits the
  Workers Paid plan's 10 MB cap; **does not fit** the free plan.
- **ASSETS bundle**: a single `app.tar.gz` containing the PHP project, ~5 KB
  for the demo. ASSETS storage is free.
- **PHP version**: 8.5.2.
- **EMSDK**: 3.1.74 (see `build/README.md` for why).

See [`packages/workers-php/README.md`](packages/workers-php/README.md)
for the full library API.
