# workers-php

Run PHP applications on Cloudflare Workers Containers. Your PHP app
(Laravel, Symfony, or plain PHP) runs unchanged in a container; the
Worker fronts traffic, serves R2 objects, holds requests while the
container boots, and answers the container's outbound calls to D1, R2
and email — plain HTTP against "magic" hosts, no FPM socket tricks.

## How it works

```
browser ──► Worker (phpWorker)
              ├── /storage/* ──► R2 (no container boot needed)
              └── everything else ──► Durable Object ──► container :8080
                                        ▲
container ──► http://example.com/{DB,FILES,EMAIL} ──► outboundByHost ──► D1 / R2 / send_email
```

The container's contract with the Worker is exactly two things:

1. a **TCP port** serving HTTP (8080 by default), and
2. a **ready flag file** (`/tmp/workers-php-ready`) that appears once the
   app is safe to serve.

Until the flag exists the app answers `503 + Retry-After` and the Worker
holds traffic through the boot window, so cold starts surface as a short
wait, never as an error page.

## Install

```sh
npm install workers-php
composer require workers-php/workers-php
```

The worker side ships on npm; the PHP runtime ships on Packagist under
the same name. Composer consumers get the runtime in `vendor/`; apps
without composer can autoload it from `node_modules/workers-php/php/`
instead. On Laravel, the service providers register themselves via
package discovery.

You write four files; the library ships everything else (PHP runtime,
reference entrypoint, Caddy config) inside the npm package.

### worker.ts

```ts
import { ContainerProxy, phpWorker } from "workers-php";

export { AppContainer } from "./do";
export { ContainerProxy };

export default phpWorker({
    container: "CONTAINER",
    name: "app",
    storage: { bucket: "FILES", prefix: "/storage/" },
});
```

### do.ts

```ts
import { env as workerEnv } from "cloudflare:workers";
import {
    d1,
    kv,
    log,
    mail,
    phpOutbound,
    PhpContainer,
    queue,
    r2,
} from "workers-php";

export class AppContainer extends PhpContainer {
    sleepAfter = "10m";
    pingEndpoint = "/ping.php";

    envVars = {
        APP_KEY: workerEnv.APP_KEY,
        DB_CONNECTION: "d1",
        DB_D1_ENDPOINT: "http://example.com/DB",
        FILESYSTEM_DISK: "r2",
        R2_ENDPOINT: "http://example.com/FILES",
        MAIL_MAILER: "http-mail",
        MAIL_ENDPOINT: "http://example.com/EMAIL",
        CACHE_STORE: "database",
        KV_ENDPOINT: "http://example.com/KV",
        SESSION_DRIVER: "cookie",
        QUEUE_CONNECTION: "cfqueue",
        QUEUE_ENDPOINT: "http://example.com/QUEUE",
        LOG_CHANNEL: "stderr",
    };
}

AppContainer.outboundByHost = phpOutbound(
    d1("DB"),
    r2("FILES"),
    kv("KV"),
    queue("QUEUE"),
    mail("EMAIL"),
    log(),
);
```

### wrangler.jsonc

```jsonc
{
    "name": "my-app",
    "main": "worker.ts",
    "compatibility_date": "2026-09-15",
    "containers": [
        {
            "name": "app",
            "class_name": "AppContainer",
            "image": "./Dockerfile",
            "image_build_context": "../..",
            "max_instances": 1,
            "instance_type": "basic",
        },
    ],
    "durable_objects": {
        "bindings": [{ "name": "CONTAINER", "class_name": "AppContainer" }],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AppContainer"] }],
    "d1_databases": [
        { "binding": "DB", "database_name": "my-app", "database_id": "…" },
    ],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "my-app" }],
    "kv_namespaces": [{ "binding": "KV", "id": "…" }],
    "queues": {
        "producers": [{ "binding": "QUEUE", "queue": "my-app" }],
        "consumers": [
            { "queue": "my-app", "max_batch_size": 10, "max_retries": 3 },
        ],
    },
    "send_email": [
        {
            "name": "EMAIL",
            "allowed_sender_addresses": ["noreply@example.com"],
        },
    ],
}
```

### Dockerfile

The image layout must mirror the composer's relative PSR-4 paths (see
the PHP section below):

```dockerfile
FROM composer:2 AS vendor
WORKDIR /srv/my-app
COPY my-app/composer.json my-app/composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --ignore-platform-req=ext-gd
COPY my-app/ ./
COPY node_modules/workers-php/php /srv/node_modules/workers-php/php
RUN rm -f bootstrap/cache/*.php \
    && composer install --no-dev --optimize-autoloader --classmap-authoritative --ignore-platform-req=ext-gd

FROM dunglas/frankenphp:1-php8.5-bookworm AS runtime
RUN install-php-extensions gd intl bcmath zip opcache \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
ENV SERVER_NAME=:8080
ENV APP_DIR=/srv/my-app
WORKDIR /srv
COPY --from=vendor /srv /srv
COPY node_modules/workers-php/etc/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

`wrangler` supports `image_build_context`, so the image can `COPY` from
`node_modules/workers-php/...`. The reference entrypoint honours
`APP_DIR`, `SERVER_CMD` and `WORKERS_PHP_READY_FLAG`; replace it with
your own if you need something else — only the port + ready-flag
contract matters.

## The PHP runtime

The package ships three PSR-4 trees, dependency-split:

| Tree           | Namespace             | Needs                  |
| -------------- | --------------------- | ---------------------- |
| `php/base/`    | `WorkersPhp\`         | nothing (ext-curl)     |
| `php/laravel/` | `WorkersPhp\Laravel\` | illuminate + flysystem |
| `php/symfony/` | `WorkersPhp\Symfony\` | symfony/mailer         |

Map them in your `composer.json`:

```json
{
    "autoload": {
        "psr-4": {
            "WorkersPhp\\": "node_modules/workers-php/php/base/",
            "WorkersPhp\\Laravel\\": "node_modules/workers-php/php/laravel/",
            "WorkersPhp\\Symfony\\": "node_modules/workers-php/php/symfony/"
        }
    }
}
```

### Base clients (framework-free)

- `WorkersPhp\D1\D1HttpClient` — `query()` / `exec()` against a D1
  endpoint, with PDO-style named-placeholder rewriting.
- `WorkersPhp\D1\HttpD1PDO` + `HttpD1PDOStatement` — drop-in PDO whose
  handle is the endpoint; last insert id from D1 meta.
- `WorkersPhp\R2\R2HttpClient` — `get` / `head` / `put` / `delete`
  (single or batch) / `list`.
- `WorkersPhp\KV\KVHttpClient` — `get` (value + metadata) / `put` (TTL +
  metadata) / `delete` / `list`.
- `WorkersPhp\Analytics\AnalyticsHttpClient` — `write()` data points to
  an Analytics Engine dataset (20 blobs, 20 doubles, one index per
  call).
- `WorkersPhp\Queue\QueueHttpClient` — `send` / `sendJson` /
  `sendBatch` to a Cloudflare Queue (producing; see
  [Queues](#queues)).
- `WorkersPhp\Mail\MailHttpClient` — structured send (no raw MIME).
- `WorkersPhp\Session\D1SessionHandler` — `SessionHandlerInterface` backed
  by D1 with a `register()` convenience and first-use table creation;
  durable sessions in one line.

Every client takes an optional transport callable:

```php
new D1HttpClient("http://example.com/DB", fn ($m, $u, $h, $b) => [200, [], "{}"]);
```

so tests (and alternative HTTP stacks) substitute their own; the default
is `WorkersPhp\Http\CurlTransport`.

### Laravel

Register the providers in `bootstrap/providers.php`:

```php
return [
    App\Providers\AppServiceProvider::class,
    WorkersPhp\Laravel\CloudflareServiceProvider::class,
    WorkersPhp\Laravel\D1ServiceProvider::class,
];
```

and prepend `WorkersPhp\Laravel\Middleware\WaitForBoot` in
`bootstrap/app.php`. Then:

**Database** (`config/database.php`) — the `d1` driver needs the full
SQLite connection shape even though only `endpoint` is used:

```php
'd1' => [
    'driver' => 'd1',
    'endpoint' => env('DB_D1_ENDPOINT', 'http://example.com/DB'),
    'database' => ':memory:',
    'prefix' => '',
    'foreign_key_constraints' => env('DB_FOREIGN_KEYS', true),
],
```

**Cache** (`config/cache.php`):

```php
'kv' => [
    'driver' => 'kv',
    'endpoint' => env('KV_ENDPOINT', 'http://example.com/KV'),
],
```

then `CACHE_STORE=kv`. TTLs ride KV's native expiration; `flush()` sweeps
the store's prefix (KV has no atomic clear).

**Filesystem** (`config/filesystems.php`):

```php
'r2' => [
    'driver' => 'r2',
    'endpoint' => env('R2_ENDPOINT', 'http://example.com/FILES'),
    'url_prefix' => env('R2_URL_PREFIX', '/storage'),
],
```

Objects are served by the Worker under the URL prefix (no container
boot), and `Storage::url()` produces those URLs.

**Mail** (`config/mail.php`):

```php
'http-mail' => [
    'transport' => 'http-mail',
    'endpoint' => env('MAIL_ENDPOINT', 'http://example.com/EMAIL'),
],
```

### Symfony

`WorkersPhp\Symfony\Mailer\HttpMailTransport` implements Symfony Mailer's
`TransportInterface` over the structured endpoint; Laravel registers it
as the `http-mail` transport, plain Symfony apps wire it directly.

### Hyperdrive

Postgres behind a Hyperdrive binding speaks the same D1 query protocol,
so the PHP runtime is unchanged; the worker side lives behind an
optional subpath because it needs the `postgres` driver package and the
`nodejs_compat` flag:

```sh
npm install postgres
```

```jsonc
{
    "compatibility_flags": ["nodejs_compat"],
    "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "…" }],
}
```

```ts
import { hyperdrive } from "workers-php/hyperdrive";

AppContainer.outboundByHost = phpOutbound(hyperdrive("HYPERDRIVE"));
```

PHP talks to the endpoint with `WorkersPhp\Hyperdrive\HttpPgsqlPDO`
(`ATTR_DRIVER_NAME` reports `pgsql`). Laravel gets a full
`DB_CONNECTION=hyperdrive` through `CloudflareServiceProvider`
(`config/database.php`):

```php
'hyperdrive' => [
    'driver' => 'hyperdrive',
    'endpoint' => env('DB_HYPERDRIVE_ENDPOINT', 'http://example.com/HYPERDRIVE'),
    'database' => env('DB_DATABASE', 'postgres'),
    'prefix' => '',
],
```

`?` placeholders are rewritten to Postgres's `$n` in the worker; write
jsonb's `?` operator family as `jsonb_exists()`, `jsonb_exists_any()` or
`jsonb_exists_all()`. Insert ids come from `RETURNING` instead of
`PDO::lastInsertId()`.

### Queues

Producing rides the `cfqueue` driver (`config/queue.php`):

```php
'cfqueue' => [
    'driver' => 'cfqueue',
    'endpoint' => env('QUEUE_ENDPOINT', 'http://example.com/QUEUE'),
],
```

then `QUEUE_CONNECTION=cfqueue`. `push`, `later` (via `delaySeconds`)
and `bulk` work as usual. Consuming runs inside the container through a
dedicated internal endpoint — see
[Queue consuming](#queue-consuming).

## Outbound host

`phpOutbound(d1("DB"), r2("FILES"), mail("EMAIL"), log())` routes all of
the container's outbound calls through a single shared host —
`example.com` by default, override with `phpOutbound({ host: "…" }, …)`.

Interception keys on the **host** alone and diverts traffic to the worker
before egress, so the host never receives real traffic — only its DNS
record matters, because interception happens per-connection _after_ DNS
resolution. `example.com` is IANA-reserved and always resolvable, which
is exactly what makes it safe to hardcode. Each factory answers under a
path named after its binding, verbatim: `d1("DB")` serves
`http://example.com/DB/*` — keep the `*_ENDPOINT` env vars in step.

The `log()` handler is a debug sink: POSTs to `/log` land in the worker's
tail. Drop it for production, or pass `{ sink: "https://…" }` to also
forward the output to a real collector.

`service("API")` proxies to a service binding verbatim — method, path,
query and body ride through, no PHP client needed:

```jsonc
{ "services": [{ "binding": "API", "service": "other-worker" }] }
```

```php
Http::get(env("API_ENDPOINT")."/users"); // http://example.com/API/users
```

## Caveats

- Migrations run at container boot over HTTP; keep them small.
- Transactions are no-ops (D1 has none); a `D1Connection` shim aligns
  Laravel 13's SQLite transaction SQL with that.
- One container instance is one PHP process tree; size `instance_type`
  and `sleepAfter` accordingly.

## Repository layout

- `src/`, `php/`, `etc/`, `tests/` — the library itself
- `examples/laravel` — a full Laravel app consuming the library; the
  living reference for the four files above

## License

Apache-2.0
