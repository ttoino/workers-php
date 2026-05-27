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
- **Workers Paid plan only.** The PHP wasm itself is ~9 MB gzipped, which
  exceeds the free plan's 3 MB Worker cap. (The PHP project files don't
  contribute — they're served as ASSETS, which is free.)
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

- **Workers Free plan is unsupported.** The PHP wasm alone is ~9 MB gz,
  exceeding the free plan's 3 MB Worker bundle cap.
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
  bcmath, calendar, ctype, date, dom, exif, filter, gd, hash, iconv,
  json, libxml, openssl, pcre, pdo, pdo_sqlite, phar, random, reflection,
  session, simplexml, spl, sqlite3, standard, tidy, tokenizer, xml,
  xmlreader, xmlwriter, yaml, zip, zlib.
- **Missing extensions:** `mbstring` (Laravel falls back to the polyfill),
  `fileinfo`, `curl`, `intl`.

## Future work

- D1 / KV / R2 PDO adapters so PHP code can natively query Cloudflare
  storage primitives.
- Per-file lazy mount mode for larger codebases.
- mbstring / fileinfo / intl in the bundled wasm.
- Multiple PHP versions selectable at build time.

## License

Apache-2.0. The bundled PHP wasm is built from
[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm), which is
itself Apache-2.0 + GPL-2.0 (PHP).
