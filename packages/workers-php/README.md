# workers-php

[![test](https://github.com/ttoino/php-wasm-worker/actions/workflows/test.yml/badge.svg)](https://github.com/ttoino/php-wasm-worker/actions/workflows/test.yml)

Run a PHP project on **Cloudflare Workers**, with the project files stored
in the Workers **ASSETS** binding so they don't count against the
[64 MiB uncompressed](https://developers.cloudflare.com/workers/platform/limits/#worker-size)
Worker bundle size limit (same on Free and Paid since 2026-09-04).

Backed by a [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm)
build compiled with `MAIN_MODULE=0 ASYNCIFY=1` so it works inside the
Cloudflare Workers runtime (which forbids runtime WebAssembly compilation).

## Status

- **PHP 8.5.2** runtime.
- **Works on every Workers plan.** The bundle is ~33 MB uncompressed
  (~10.5 MB gzipped) and Cloudflare's
  [64 MiB uncompressed limit](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)
  applies identically to Free and Paid — leaving ~32 MiB of headroom. The
  Free plan's 10 ms CPU-time limit is the practical constraint there
  (see [Limitations](#limitations)); Paid is the realistic plan for real
  apps. (The PHP project files don't contribute to the bundle — they're
  served as ASSETS, which is free.)
- Single-tarball mount mode. Per-file lazy mount is on the roadmap.
- Tested with Laravel 13 and basic vanilla PHP. Should work for any PHP
  app whose extension requirements are satisfied (see below).

## Install

```bash
npm install workers-php
```

You also need `wrangler` configured for your account.

## Quick start

1. **Drop your PHP project into a directory.** The default layout the CLI
   expects is `./php/public/index.php` (i.e. document root at `public/`),
   but `--docroot` and `--entrypoint` let you override that.

2. **Add a Worker entrypoint** at `src/index.ts`:

   ```ts
   import { createPhpHandler } from "workers-php";

   export default {
     fetch: createPhpHandler(),
   };
   ```

3. **Configure Wrangler** to use the bundled assets and to invoke your
   Worker first:

   ```jsonc
   // wrangler.jsonc
   {
     "name": "my-php-app",
     "main": "src/index.ts",
     "compatibility_date": "2026-05-26",
     "compatibility_flags": ["nodejs_compat"],
     "assets": {
       "directory": "./dist",
       "binding": "ASSETS",
       "run_worker_first": true
     }
   }
   ```

4. **Build the assets and run.**

   ```bash
   npx workers-php build ./php
   npx wrangler dev
   ```

   For deploy:

   ```bash
   npx workers-php build ./php
   npx wrangler deploy
   ```

## CLI

```
workers-php build [project] [options]
```

| Flag | Default | Description |
|---|---|---|
| `[project]` | `./php` | Directory containing the PHP project. |
| `--out`, `-o <dir>` | `./dist` | Output directory for built assets. |
| `--docroot <subpath>` | `public` | Document root relative to project. |
| `--entrypoint <file>` | `index.php` | Entry script inside docroot. |
| `--ignore-file <path>` | `<project>/.workersphpignore` | gitignore-style ignore patterns. |
| `--write-config` | (off) | Merge `assets` block into `wrangler.jsonc`. |

Default ignores include `.git/`, `node_modules/`, `tests/`, `*.md`,
`storage/{logs,framework/{cache,sessions,views}}/`, etc. You can extend
or replace the list with a `.workersphpignore` file in the project root.

## API

### `createPhpHandler(options)`

Returns a Worker fetch handler `(request, env, ctx) => Response`.

| Option | Default | Description |
|---|---|---|
| `appRoot` | `"/persist/app"` | Where the project is mounted in the wasm FS. |
| `docroot` | `"public"` | Document root, relative to `appRoot`. |
| `entrypoint` | `"index.php"` | Entry script, relative to `docroot`. |
| `assetsBinding` | `"ASSETS"` | Name of the Wrangler ASSETS binding. |
| `appAssetPath` | `"/app.tar.gz"` | URL path of the bundled tarball in ASSETS. |
| `stripPrefix` | `"app"` | Directory prefix stripped from each tar entry. The CLI writes `app/...`. |
| `staticExtensions` | (see below) | File extensions short-circuited to ASSETS. |
| `extraStaticExtensions` | `[]` | Add extensions on top of the defaults. |
| `disableStaticShortCircuit` | `false` | Send every request to PHP. |
| `envOverrides` | `{}` | `.env` keys written to `<appRoot>/.env` and `putenv()`-injected per request. |
| `displayErrors` | `true` | PHP `display_errors` ini per request. Set `false` for production so warnings/notices don't leak into HTML. |
| `errorReporting` | `"E_ALL"` | Raw expression for `error_reporting(...)`. Use e.g. `"E_ERROR \| E_PARSE"` to silence everything below errors. |
| `maxBodyBytes` | `50_000_000` | Cap on request body size. Oversized → 413 Payload Too Large. |
| `bindings` | `{}` | Cloudflare bindings exposed to PHP via `$env`. See below. |
| `staticRoutes` | `[]` | URL-prefix matches routed to a binding before the ASSETS short-circuit. |
| `bridgeMethods` | `{}` | Raw `Module.workersPhpBridge` entries for `workers_php_call()`. |
| `bridgeMethodsForRequest` | — | `(request, env) => methods` for per-request bridge methods. |
| `sessionHandler` | — | Persist `$_SESSION` to D1 or KV. See [Sessions](#sessions). |
| `onLog` | `console.warn`-stderr | `(level, text) => void` for runtime telemetry. |

Default static extensions (forwarded straight to `env.ASSETS.fetch()`
without invoking PHP):

```
css js mjs map png jpg jpeg gif svg ico webp avif bmp
woff woff2 ttf otf eot
mp3 mp4 webm ogg wav flac
pdf txt xml json wasm
```

### Composing with custom routes

```ts
import { createPhpHandler } from "workers-php";

const php = createPhpHandler({
  envOverrides: {
    APP_ENV: "production",
    LOG_LEVEL: "warning",
  },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return php(request, env, ctx);
  },
};
```

### Lower-level building blocks

If you need to drive PHP yourself, the package also exports:

- `getPhp()` — singleton `PhpWeb` instance (one per isolate).
- `withPhpLock(fn)` — serialize work through the singleton.
- `ensureMounted(php, assets, opts)` — idempotent ASSETS-backed mount.
- `buildPrelude(request, opts)` / `buildCapture()` / `makeCaptureSlot()` —
  CGI shims and response capture.
- `iterTar(buf)` / `gunzip(bytes)` — minimal POSIX ustar parser and gzip decoder.
- `installBridge(php, methods)` / `setBridgeMethods(php, methods)` — install
  arbitrary `Module.workersPhpBridge[method]` handlers callable from PHP via
  `workers_php_call($method, $args)`.

## Cloudflare bindings in PHP

`createPhpHandler` accepts a `bindings` map mirroring the user's
`wrangler.jsonc`. Each declared name shows up on a magic `$env`
superglobal in PHP, with method names that mirror the Workers JS
binding API.

```jsonc
// wrangler.jsonc
{
  "d1_databases":  [{ "binding": "DB",     "database_name": "...", "database_id": "..." }],
  "r2_buckets":    [{ "binding": "IMAGES", "bucket_name":   "..." }],
  "kv_namespaces": [{ "binding": "KV",     "id":            "..." }],
  "vars":          { "APP_ENV": "production" }
}
```

```ts
// src/index.ts
import { createPhpHandler } from "workers-php";

export default {
  fetch: createPhpHandler({
    docroot: ".",
    entrypoint: "index.php",
    bindings: {
      DB:      "d1",
      IMAGES:  "r2",
      KV:      "kv",
      APP_ENV: "var",
    },
    staticRoutes: [
      // GET /uploads/<key> → env.IMAGES.get(<key>) (falls back to ASSETS).
      { pathPrefix: "/uploads/", from: "IMAGES" },
    ],
  }),
};
```

```php
// index.php
/** @var \WorkersPHP\Env $env */

// D1
$row = $env->DB->prepare('SELECT * FROM x WHERE id = ?')->bind(1)->first();
$env->DB->prepare('INSERT INTO x (n) VALUES (:n)')
        ->execute([':n' => 'hello'])
        ->run();

// R2
$obj = $env->IMAGES->get('photos/cat.webp');
if ($obj) echo $obj->body();           // raw bytes
$env->IMAGES->put('photos/cat.webp', $bytes, ['contentType' => 'image/webp']);

// KV
$cached = $env->KV->get('cache:user:42');
$env->KV->put('cache:user:42', json_encode($user));

// vars / secrets
echo $env->APP_ENV;                    // "production"
```

**PDO compatibility shim.** For apps that hardcode `new PDO('sqlite:...')`
(everything Laravel-shaped), workers-php ships `\WorkersPHP\D1PDO` —
a drop-in that implements the PDO surface area people actually use
(`prepare/query/exec/lastInsertId/begin/commit/rollback/quote/
setAttribute/getAttribute/errorInfo` plus a PDOStatement-compatible
class with `execute/bindValue/bindParam/fetch/fetchAll/fetchColumn/
fetchObject/rowCount/columnCount/closeCursor/setFetchMode` and
iteration). Named placeholders (`:name`) are translated to positional
inside the shim, since D1's binding API is positional-only.

```php
// One-line swap from PDO to D1:
$pdo = new \WorkersPHP\D1PDO($env->DB);    // was: new PDO('sqlite:main.db')
$stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email');
$stmt->execute([':email' => $email]);
$user = $stmt->fetch();
```

The full binding API lives in `packages/workers-php/php/lib.php`. A
working example exercising D1 + R2 + KV + vars is in
[`examples/bindings-demo/`](../../examples/bindings-demo).

### Under the hood

All binding calls funnel through one Asyncify-suspending PHP function,
`workers_php_call(string $method, array $args)`, exported by the bundled
`workers_php_bridge` C extension. The library installs
`Module.workersPhpBridge` with one JS handler per binding operation
(`d1_all`, `d1_run`, `r2_get`, `r2_put`, `kv_get`, …). PHP code never
sees the bridge directly — it goes through the `\WorkersPHP\D1Database` /
`R2Bucket` / `KVNamespace` classes — but you can add your own dispatch
entries via the `bridgeMethods` / `bridgeMethodsForRequest` options.

## Sessions

Out of the box, PHP `$_SESSION` is backed by `/tmp/sess_<id>` files inside
the wasm's RAM filesystem — they vanish on every isolate recycle. To make
sessions survive, point the save handler at D1 or KV via the
`sessionHandler` option:

```ts
createPhpHandler({
  bindings: { DB: "d1" },        // or { KV: "kv" }
  sessionHandler: {
    backend: "d1",               // or "kv"
    from:    "DB",               // binding name
    // table:      "workers_php_sessions",  // D1 only, optional
    // keyPrefix:  "sess:",                 // KV only, optional
    // ttlSeconds: 86400,                   // optional, default 24h
    // strictMode: true,                    // session.use_strict_mode
  },
});
```

The library calls `session_set_save_handler($handler, true)` in the
prelude — your PHP code's `session_start()` / `$_SESSION[...]` / etc.
keep working unchanged.

D1 backend creates `workers_php_sessions(id TEXT PRIMARY KEY, data BLOB,
expires INTEGER)` on first use; the result is cached per-isolate so
subsequent requests skip the DDL round-trip. Use D1 when you want strong
consistency and no per-key write-rate limit; xaufome's login flow uses
this.

KV backend writes one value per session id under the configured prefix
with `expirationTtl` set to `ttlSeconds`, so expiry is native. Watch out
for KV's 1-write-per-second-per-key cap on chatty sessions, plus its
~60-second eventual consistency window.

You can also ship your own handler — instantiate any
`\SessionHandlerInterface` and register it yourself in PHP-userland
before `session_start()`. The auto-install is only triggered when
`sessionHandler` is set.

## How it works

```
       ┌─────────────────────────────────────────────────────┐
       │  Cloudflare Worker (your code, < 64 MiB uncompressed)│
       │                                                     │
       │  ┌──────────────────────────────────────────────┐   │
       │  │ workers-php library                          │   │
       │  │   PhpWeb (Emscripten) singleton              │   │
       │  │   per-isolate request lock                   │   │
       │  └──────────┬─────────────────────────┬─────────┘   │
       └────────────│─────────────────────────│─────────────┘
                    │ first request only      │ every request
                    ▼                         ▼
            env.ASSETS.fetch                env.ASSETS.fetch
            ('app.tar.gz')                  (static file)
                    │                         │
                    │ gunzip + untar          │ direct passthrough
                    ▼                         ▼
            wasm FS at /persist/app          (no PHP cost)
            <appRoot>/public/index.php  ←── PHP entrypoint
```

- The Worker imports the PHP wasm runtime once per isolate.
- The first PHP request fetches `app.tar.gz` via the ASSETS binding,
  decompresses with the runtime's `DecompressionStream("gzip")`, and
  untars into the wasm filesystem.
- Subsequent requests skip the mount and just `require` the entrypoint
  with `$_SERVER`/`$_GET`/`$_POST`/`$_COOKIE` synthesized from the
  incoming `Request`.
- PHP's `header()`, `http_response_code()` and body output are captured
  via an `ob_start()` handler. The handler pushes the response snapshot
  through the `workers_php_bridge` C extension into a JS-side variable
  the library reads after `pib_run` returns. The bundled PHP wasm
  carries a small `pib.c` patch (`build/patches/pib.c`) that forces
  `php_call_shutdown_functions` + `php_output_end_all` to fire at the
  end of every script, so the capture handler runs for **every** exit
  path — normal end, exceptions, and `exit()`/`die()` too. (Stock
  `pib_run` skips request-shutdown entirely, which means a script that
  `header('Location: ...'); die()`s leaves PHP without ever invoking
  any of those callbacks and the response would otherwise be lost.)

## Limitations

- **Workers Free plan: fits, but impractical.** Bundle size is fine on
  every plan (~33 MB uncompressed vs the 64 MiB limit that applies to
  Free and Paid alike since 2026-09-04). The constraint is CPU time:
  Free allows 10 ms per request, while a warm vanilla PHP request uses
  ~20 ms CPU — so most real traffic would hit
  [Error 1102](https://developers.cloudflare.com/workers/observability/errors/).
  Use the Paid plan (5 min CPU).
- **Persistent storage.** The wasm filesystem is RAM-only and is discarded
  when the isolate is reclaimed. SQLite/file writes work between requests
  in the same isolate, but disappear when the isolate dies. For real
  persistence use the built-in D1/R2/KV bridging (`$env->DB`, `$env->IMAGES`,
  `$env->KV` — see above).
- **Outbound HTTP works via a curl polyfill, not the real extension.**
  The bundled wasm has no `ext-curl` (upstream php-wasm has no build
  recipe), but the runtime defines global `curl_*` functions backed by
  the Worker's `fetch()` through the bridge — covering
  `curl_init/setopt(_array)/exec/getinfo/errno/error/close` with
  `CURLOPT_URL`, `RETURNTRANSFER`, `POST`, `POSTFIELDS`, `CUSTOMREQUEST`,
  `NOBODY`, `HTTPHEADER`, `USERAGENT`, `FOLLOWLOCATION`, `TIMEOUT`,
  `HEADER`, plus the common `CURLINFO_*` values. That's enough for
  typical SDK call sites (Guzzle, payment SDKs, WordPress's curl
  transport). Caveats: full body buffered (no streaming), no multi
  handles, TLS options are no-ops (fetch always verifies), and each call
  consumes a Workers subrequest (50/request on Free, 10,000 on Paid).
- **Cold start.** Each new isolate downloads + extracts the tarball on
  the first request (~50–300 ms depending on app size). Warm requests
  are fast (~20 ms for vanilla PHP, ~200 ms for Laravel).
- **CPU time on Paid.** 5 min CPU per request (30 s default,
  configurable). Laravel boot uses ~200 ms CPU per warm request —
  comfortable.
- **Memory.** Workers' 128 MB isolate cap. The mounted tar plus the wasm
  heap means projects up to ~50 MB unpacked are comfortable; larger may OOM.
- **Compiled-in PHP extensions** (verified against the bundled wasm at
  runtime; enforced by a test): bcmath, calendar, ctype, date, dom, exif,
  fileinfo, filter, gd, hash, iconv, json, libxml, mbstring, openssl,
  pcre, pdo, pdo_sqlite, phar, random, reflection, session, simplexml,
  spl, sqlite3, standard, tidy, tokenizer, xml, xmlreader, xmlwriter,
  yaml, Zend OPcache, zip, zlib.
- **Missing extensions:** `curl` (no build support in upstream php-wasm;
  covered by the userland polyfill described above) and `intl`
  (buildable — see below). Laravel needs neither: it ships
  `symfony/polyfill-*` shims and its HTTP client works over the polyfill.
- **About `intl`:** `WITH_INTL=static` compiles ICU 72.1 into the wasm
  (+~15 MB uncompressed — affordable under the 64 MiB limit), but it also
  emits an `icudt72l.dat` Emscripten *preload data file* that the runtime
  would have to fetch and mount next to `php-web.wasm`. That plumbing
  doesn't exist yet, so intl stays `WITH_INTL=0` in `build/php-wasm.env`.
  The GD/image stack is enabled; disabling it (`WITH_GD=0`, etc.) shaves
  ~1.7 MB raw if you truly don't need server-side image manipulation —
  but with ~32 MiB of headroom this is no longer a trade-off worth making
  for size reasons alone.

## Future work

- Per-file lazy mount mode for larger codebases.
- `intl` runtime plumbing (preload data file loading; the extension
  itself already compiles — see Limitations).
- Real `ext-curl` (requires upstream php-wasm support; the userland
  polyfill covers the common API meanwhile).
- Multiple PHP versions selectable at build time.

## License

Apache-2.0. The bundled PHP wasm is built from
[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm), which is
itself Apache-2.0 + GPL-2.0 (PHP).
