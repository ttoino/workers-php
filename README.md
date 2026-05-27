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
a 65-file PHP-from-scratch restaurant site backed by SQLite. The
upstream repo isn't committed here; the build script clones it and
overlays a router and a pre-built `main.db`.

```bash
git clone https://github.com/ttoino/feup-ltw-proj.git feup-ltw-proj
npm install                # if you haven't already
npm run dev:feup           # serves at http://localhost:8787
# or: npm run deploy:feup
```

Required on the host: the `sqlite3` CLI (used to seed `database/main.db`
from the project's `database/schema/*.sql` files).

Working: home, login, register, profile, restaurant detail pages,
search, the JSON API (`/api/...`), static assets, the 404 page, and
the register/login/logout flow end to end (sessions are PHP-file-based
in the wasm's RAM filesystem, so they only live within one isolate).

Not working — by design, since the project was never written for a
serverless backend:

- **Image uploads** (`actions/edit_profile.php`, `actions/edit_restaurant.php`)
  go through `$_FILES`, which workers-php's CGI prelude doesn't parse
  for `multipart/form-data` bodies. The build overlay flips every form
  to `application/x-www-form-urlencoded` so login/register/etc. work,
  at the cost of image uploads.
- **Writes don't persist across isolate recycles.** Registrations,
  reviews, and cart edits all succeed but vanish when the Worker isolate
  is replaced (and on every `wrangler dev` restart).
- **`/cart/`** throws because the upstream `cart/index.php` calls
  `pageError()` without `require`ing `lib/page.php`. That's a bug in
  the project's code, not the runtime.

The build steps live in `build/`:

- `build/build-feup.sh` — seeds `database/main.db` from the project
  schema, overlays `build/feup/router.php`, and patches the project's
  `templates/form.php` + `lib/session.php` for the workers-php runtime.
- `build/build-feup-static.sh` — copies `style/`, `scripts/`, `assets/`
  from the project into `dist-feup/` so Wrangler serves them as static
  files directly (the same content is also inside `app.tar.gz` so PHP
  can `require` it).
- `build/feup/router.php` — Apache-style front controller (resolves
  `/foo/` → `/foo/index.php`, redirects `/foo` → `/foo/`, etc.).

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
