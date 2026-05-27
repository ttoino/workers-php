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
// src/index.ts
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
examples/bindings-demo/       Reference PHP app using D1 + R2 + KV + vars
                              through the `$env` superglobal.
src/index.ts                  Tiny demo Worker (~10 lines), the original PHP demo.
src/bindings-index.ts         Worker entrypoint for examples/bindings-demo.
src/feup-index.ts             Worker that deploys ttoino/feup-ltw-proj
                              (xaufome). See "Run the xaufome deployment".
php/                          PHP project for the basic demo.
wrangler.jsonc                Basic demo config.
wrangler.bindings.jsonc       Bindings-demo config (D1 + R2 + KV + var).
wrangler.feup.jsonc           xaufome deployment config.
```

## Run the basic demo

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

## Run the bindings demo

A second demo under `examples/bindings-demo/` exercises D1, R2, KV, and
vars via the `$env` superglobal that workers-php injects into PHP.

```bash
npx wrangler d1 create        workers-php-demo-db
npx wrangler r2 bucket create workers-php-demo-images
npx wrangler kv namespace create workers-php-demo-kv
# Paste the resulting IDs into wrangler.bindings.jsonc, then:
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

## Run the xaufome deployment

A second deployment recipe runs [ttoino/feup-ltw-proj][feup] (xaufome),
a 65-file PHP-from-scratch restaurant site originally written for a
LAMP stack. Persistence is now backed by:

- **Cloudflare D1** for the relational data (users, restaurants,
  dishes, menus, orders, reviews) via `$env->DB`.
- **Cloudflare R2** for user-uploaded restaurant/dish/menu/profile
  images via `$env->IMAGES`, served straight back out at
  `/assets/pictures/<type>/<id>.webp` with a `staticRoutes` rule.

The upstream repo isn't committed here; the build script clones it,
overlays a router and a few small adapter files, and the rest of the
PHP code runs unchanged.

```bash
git clone https://github.com/ttoino/feup-ltw-proj.git feup-ltw-proj
npm install

# One-time wrangler setup
npx wrangler d1     create xaufome-db
npx wrangler r2     bucket create xaufome-images
# Paste the resulting D1 UUID into wrangler.feup.jsonc

# Seed the schema into local D1 (~5 seconds)
npm run feup:migrate:local

npm run dev:feup           # serves at http://localhost:8787
# or: npm run deploy:feup  (preceded by `npm run feup:migrate:remote`)
```

Working end-to-end (verified against `wrangler dev`):

- Home, login, register, profile, restaurant detail pages, search, JSON
  API, static assets, 404 page.
- Register/login/logout flow.
- `/cart/` (upstream `pageError()`-without-require bug fixed in the
  overlay).
- **Multipart image uploads** to `actions/edit_profile.php` and
  `actions/edit_restaurant.php`. Resized via GD, encoded as WebP, stored
  in R2.
- **Persistence across isolate recycles.** Registrations, reviews, cart
  contents, uploaded images, **and login sessions** all survive
  `wrangler dev` restarts. PHP `$_SESSION` is backed by the
  `workers_php_sessions` table in D1 via `SessionHandlerD1` (auto-
  created on first use; no migration needed).

Known limitations (deferred):

- **PUT / DELETE bodies** that read `$_POST` via `parse_str(file_get_contents('php://input'))`
  see an empty body (the library's prelude doesn't populate `$_POST`
  for those verbs yet).
- **Outbound HTTP** from PHP is unavailable (the `curl` extension isn't
  compiled into the bundled wasm); the app doesn't need it.

The build steps live in `build/`:

- `build/build-feup.sh` — installs router.php, overlays a D1-backed
  `database/connection.php` and an R2-backed `lib/files.php`, patches
  `lib/session.php` (cookie_secure conditional on HTTPS), patches
  `database/models/model.php` (`HasImage::getImagePath` no longer
  probes MEMFS), patches `cart/index.php` (adds missing `require_once`),
  copies default-image placeholders.
- `build/build-feup-static.sh` — copies `style/`, `scripts/`, `assets/`
  into `dist-feup/` for direct ASSETS serving.
- `build/feup/router.php` — Apache-style front controller.
- `build/feup/connection.php` — D1-backed `getDBConnection()`.
- `build/feup/files.php` — R2-backed `uploadImage()`.

[feup]: https://github.com/ttoino/feup-ltw-proj

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

- **Worker bundle size**: ~9.5 MB gzipped (the PHP wasm dominates). Fits the
  Workers Paid plan's 10 MB cap with ~260 KB headroom; **does not fit** the
  free plan.
- **ASSETS bundle**: a single `app.tar.gz` containing the PHP project, ~5 KB
  for the demo. ASSETS storage is free.
- **PHP version**: 8.5.2.
- **EMSDK**: 3.1.74 (see `build/README.md` for why).

See [`packages/workers-php/README.md`](packages/workers-php/README.md)
for the full library API.
