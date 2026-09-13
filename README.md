# php-wasm-worker

Monorepo containing the **[`workers-php`](packages/workers-php)** library —
which lets you run a PHP project on Cloudflare Workers, with the project
code stored in the Workers ASSETS binding — plus a couple of demo Workers
that exercise it.

PHP code can reach Cloudflare bindings directly through an `$env`
superglobal that mirrors the JS handler's `env`:

```php
// PHP
$row    = $env->DB->prepare('SELECT * FROM users WHERE id = ?')->bind(1)->first();
$env->IMAGES->put('photos/cat.webp', $bytes, ['contentType' => 'image/webp']);
$env->KV->put('cache:user:42', json_encode($user));
echo $env->APP_ENV;
```

```ts
// worker.ts
export default {
  fetch: createPhpHandler({
    docroot: ".", entrypoint: "router.php",
    bindings: { DB: "d1", IMAGES: "r2", KV: "kv", APP_ENV: "var" },
    staticRoutes: [{ pathPrefix: "/uploads/", from: "IMAGES" }],
  }),
};
```

## Layout

```
packages/workers-php/         The library. See packages/workers-php/README.md.
build/                        Scripts that compile the PHP wasm artifact from
                              seanmorris/php-wasm. See build/README.md.
examples/demo/                The original PHP demo (php/ app + worker).
examples/bindings-demo/       Reference PHP app using D1 + R2 + KV + vars
                              through the `$env` superglobal.
examples/laravel/             Stock Laravel 13 app; D1 via a custom DB
                              driver over workers-php's D1PDO.
examples/slim/                Hand-rolled Slim 4 app; D1 via $env->DB.
examples/symfony/             Stock Symfony 7 skeleton; D1 via $env->DB.
```

Every deployable app carries its own `wrangler.jsonc` + `worker.ts`
where its code lives; the repo root holds no wrangler config.
vitest-pool-workers reads `examples/demo/wrangler.jsonc` (see
vitest.config.mts).

## Run the basic demo

```bash
pnpm install
npm run dev                # build examples/demo + wrangler dev at :8787
```

Routes:

- `/` — landing page
- `/info` — `phpinfo()`
- `/hello?name=...` — query-string demo
- `/check` — PHP extensions / Laravel-requirements diagnostic
- everything else — 404 from the PHP router

## Run the bindings demo

A second demo under `examples/bindings-demo/` exercises D1, R2, KV, and
vars via the `$env` superglobal that workers-php injects into PHP.

```bash
npx wrangler d1 create        workers-php-demo-db
npx wrangler r2 bucket create workers-php-demo-images
npx wrangler kv namespace create workers-php-demo-kv
# Paste the resulting IDs into examples/bindings-demo/wrangler.jsonc, then:
npm run migrate-bindings   # apply schema.sql to local D1
npm run dev:bindings       # serve at http://localhost:8787
# or: npm run deploy:bindings
```

Features:
- `/` — guestbook (D1 reads/writes), image gallery (R2 list), visit counter (KV).
- `POST /guestbook` — D1 INSERT with named placeholders + lastInsertId.
- `POST /upload` — `multipart/form-data` upload → R2 PUT with content-type.
- `GET /uploads/<key>` — served straight from R2 via `staticRoutes`.
- `GET /counter?key=…` — KV increment-and-show.

See [`examples/bindings-demo/README.md`](examples/bindings-demo/README.md)
and [`packages/workers-php/README.md`](packages/workers-php/README.md)
for the full bindings API.

## Run the Laravel example

`examples/laravel/` is a stock Laravel 13 app (created with
`composer create-project laravel/laravel`; vendor is built at build time,
never committed). It runs on D1 through a small service provider that
registers Laravel's database layer on top of workers-php's D1PDO. Live at
<https://workers-php-laravel.toino.workers.dev>.

```bash
npm run dev:laravel        # composer install (docker) + build + wrangler dev
# or: npm run deploy:laravel  (after `wrangler d1 create workers-php-laravel-db`,
#                             pasting its id into wrangler.laravel.jsonc, and
#                             `npm run laravel:migrate:remote`)
```

The app tarball is ~5 MB — far under the 25 MiB per-asset limit, so
app code stays out of the worker bundle entirely.

## Run the Slim and Symfony examples

`examples/slim/` (Slim 4, hand-rolled) and `examples/symfony/` (stock
`symfony/skeleton` 7) serve the same D1-backed counter with no
framework-specific shims — both call `$env->DB` directly. Live at
<https://workers-php-slim.toino.workers.dev> and
<https://workers-php-symfony.toino.workers.dev>.

```bash
npm run dev:slim           # or dev:symfony
# or: npm run deploy:slim / deploy:symfony  (after `wrangler d1 create
#                             workers-php-<fw>-db`, pasting its id into
#                             wrangler.<fw>.jsonc, and `npm run <fw>:migrate:remote`)
```

## Real-world deployments

Full PHP apps deployed with workers-php live in their own repos:

- **xaufome** ([ttoino/xaufome](https://github.com/ttoino/xaufome)) —
  a 65-file PHP-from-scratch restaurant site (originally LAMP), on D1
  for relational data and R2 for uploads. Live at
  <https://xaufome.toino.workers.dev>.

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

- **Worker bundle size**: ~33 MB uncompressed (~10.5 MB gzipped; the PHP wasm
  dominates). Since the
  [2026-09-04 limit change](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/),
  Cloudflare only checks uncompressed size — **64 MiB on all plans**, so this
  fits everywhere (including Workers Free) with ~32 MiB of headroom. Note the
  Free plan's 10 ms CPU limit still makes PHP impractical there (a warm
  vanilla request uses ~20 ms CPU); Paid remains the realistic plan.
- **ASSETS bundle**: a single `app.tar.gz` containing the PHP project, ~5 KB
  for the demo. ASSETS storage is free.
- **PHP version**: 8.5.2.
- **EMSDK**: 3.1.74 (see `build/README.md` for why).

See [`packages/workers-php/README.md`](packages/workers-php/README.md)
for the full library API.
