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
src/feup-index.ts        Second Worker that deploys the xaufome PHP app
                         (ttoino/feup-ltw-proj) — see "Run the xaufome
                         deployment" below.
php/                     Demo PHP project (tiny front controller + a few pages).
wrangler.jsonc           Wrangler config for the small built-in demo.
wrangler.feup.jsonc      Wrangler config for the xaufome deployment.
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
