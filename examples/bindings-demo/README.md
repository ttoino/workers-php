# workers-php bindings demo

A small PHP app that reaches Cloudflare bindings through the workers-php
`$env` superglobal:

- **D1** — a tiny guestbook (`pages/home.php` reads, `actions/guestbook-add.php` writes).
- **R2** — image uploads (`actions/upload-image.php` PUT, `pages/home.php` LIST, `staticRoutes` serves from `/uploads/`).
- **KV** — visit counter on `/` and a tunable `/counter?key=...` page.
- **Vars** — `APP_ENV` displayed in the header.

## Run locally

```bash
# One-time setup
npx wrangler d1     create     workers-php-demo-db
npx wrangler kv     namespace  create workers-php-demo-kv
npx wrangler r2     bucket     create workers-php-demo-images
# Paste the resulting IDs into wrangler.bindings.jsonc, then:
npm run migrate-bindings           # applies schema.sql to local D1
npm run dev:bindings               # serves http://localhost:8787
```

## Deploy

```bash
# Apply schema to the remote D1
npx wrangler d1 execute workers-php-demo-db --remote --file=examples/bindings-demo/schema.sql
# Deploy the Worker
npm run deploy:bindings
```

## Layout

```
schema.sql                 D1 schema (Guestbook table).
router.php                 Tiny method+path table.
pages/home.php             Main page — reads D1, lists R2, displays KV counter.
pages/counter.php          KV increment endpoint.
actions/guestbook-add.php  D1 write (named placeholders + lastInsertId).
actions/upload-image.php   R2 write with content-type metadata.
style/main.css             Page styling.
```

## How it talks to bindings

See `src/bindings-index.ts` — `createPhpHandler({ bindings: { DB: 'd1', IMAGES: 'r2', KV: 'kv', APP_ENV: 'var' } })`.

In PHP the bindings show up on `$env`:

```php
$row    = $env->DB->prepare('SELECT * FROM x WHERE id = ?')->bind(1)->first();
$env->IMAGES->put('foo.png', $bytes, ['contentType' => 'image/png']);
$value  = $env->KV->get('cache:key');
$secret = $env->APP_ENV;   // strings for var/secret bindings
```

See `packages/workers-php/README.md` for the full API.
