# workers-php

Run a PHP project on **Cloudflare Workers**, with the project files stored
in the Workers **ASSETS** binding so they don't count against the
[3 MB free / 10 MB paid](https://developers.cloudflare.com/workers/platform/limits/#worker-size)
Worker bundle size cap.

Backed by a [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm)
build compiled with `MAIN_MODULE=0 ASYNCIFY=1` so it works inside the
Cloudflare Workers runtime (which forbids runtime WebAssembly compilation).

## Status

- **PHP 8.5.2** runtime.
- **Workers Paid plan only.** The PHP wasm itself is ~9.5 MB gzipped,
  which exceeds the free plan's 3 MB Worker cap and leaves a tight
  ~260 KB headroom under the Paid 10 MB cap. (The PHP project files
  don't contribute — they're served as ASSETS, which is free.)
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
- `buildPrelude(request, opts)` / `parseOutput(stdout)` / `buildEpilogue()` — CGI shims.
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

## How it works

```
       ┌─────────────────────────────────────────────────────┐
       │  Cloudflare Worker (your code, < 10 MB gz)          │
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
- PHP's `header()` and `http_response_code()` are captured via a small
  output-buffer wrapper and emitted as a CGI-style header block on
  stdout that the library parses into a `Response`.

## Limitations

- **Workers Free plan is unsupported.** The PHP wasm alone is ~9.5 MB
  gz, exceeding the free plan's 3 MB Worker bundle cap.
- **Persistent storage.** The wasm filesystem is RAM-only and is discarded
  when the isolate is reclaimed. SQLite/file writes work between requests
  in the same isolate, but disappear when the isolate dies. For real
  persistence, use Cloudflare D1/R2/KV from the Worker side (bridging
  those into PHP is on the roadmap).
- **No outbound HTTP from PHP** (the `curl` extension isn't built). Make
  outbound requests from JS and pass results through `envOverrides` or
  query strings if you need to call external APIs.
- **Cold start.** Each new isolate downloads + extracts the tarball on
  the first request (~50–300 ms depending on app size). Warm requests
  are fast (~20 ms for vanilla PHP, ~200 ms for Laravel).
- **CPU time.** Default 30 s CPU per request on the paid plan
  (configurable up to 5 min). Laravel boot uses ~200 ms CPU per warm
  request; comfortable headroom.
- **Memory.** Workers' 128 MB isolate cap. The mounted tar plus the wasm
  heap means projects up to ~50 MB unpacked are comfortable; larger may OOM.
- **Compiled-in PHP extensions** (as of the bundled wasm):
  bcmath, calendar, ctype, date, dom, exif, fileinfo, filter, gd, hash,
  iconv, json, libxml, openssl, pcre, pdo, pdo_sqlite, phar, random,
  reflection, session, simplexml, spl, sqlite3, standard, tidy,
  tokenizer, xml, xmlreader, xmlwriter, yaml, zip, zlib.
- **Missing extensions:** `mbstring` (Laravel falls back to the
  `symfony/polyfill-mbstring` shim it ships with), `curl`, `intl`.
  Re-enable by editing `build/php-wasm.env` and rebuilding. Disabling
  GD + image libs (`WITH_GD=0`, etc.) frees ~1.7 MB raw / ~250 KB gzip
  if you don't need server-side image manipulation.

## Future work

- D1 / KV / R2 PDO adapters so PHP code can natively query Cloudflare
  storage primitives.
- Per-file lazy mount mode for larger codebases.
- mbstring / curl / intl in the bundled wasm.
- Multiple PHP versions selectable at build time.

## License

Apache-2.0. The bundled PHP wasm is built from
[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm), which is
itself Apache-2.0 + GPL-2.0 (PHP).
