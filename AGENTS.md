# AGENTS.md

## What this is

`workers-php` — a PHP + TypeScript library for running PHP apps on
Cloudflare Workers Containers. The `wasm` branch archives the abandoned
PHP-wasm runtime; `main` is the containers line.

## Layout

- `packages/workers-php` — the publishable package
    - `src/` — TypeScript: outbound protocol handlers (`container.ts`),
      worker fetch handler with boot hold (`worker.ts`)
    - `php/base|laravel|symfony/` — the PHP runtime trees (composer
      multi-root PSR-4 map in the package's `composer.json`)
    - `etc/` — reference `entrypoint.sh` + `Caddyfile`
    - `tests/` + `php/tests/` — vitest and phpunit suites
- `examples/laravel` — full Laravel app consuming the workspace
  package; doubles as the Build check (`wrangler deploy --dry-run`)

## House rules

- **Commits**: capitalized imperative (`Add the Laravel example`), no
  conventional-commit prefixes; one logical change per commit.
- **TypeScript**: arrow functions only (`const f = () => …`), enforced
  by eslint `func-style`; no `function` declarations.
- Formatting: prettier (spaces, width 80, double quotes — see
  `.prettierrc`); sorting via eslint-plugin-perfectionist.
- PHP style: pint with its default (Laravel) preset.

## Checks

```sh
pnpm run format && pnpm run lint        # repo-wide
pnpm run check                          # tsc, every package
pnpm run test                           # vitest
pnpm run build                          # example wrangler deploy --dry-run
```

- `examples/laravel` typecheck needs its generated
  `worker-configuration.d.ts`: run `pnpm --filter
workers-php-example-laravel run gen:cf-types` after config changes
  (the file is gitignored; CI generates it before `check`).
- PHP side has no host runtime: use docker
  (`docker run --rm -v "$PWD/packages/workers-php:/app" -w /app
<php-image> sh -c 'vendor/bin/phpunit; vendor/bin/pint --test'`).
- Local `wrangler dev` of the example needs outbound hosts that resolve
  in public DNS — `db.app` does not; `d1.app` does. See README §
  Outbound hosts.

## CI

`.github/workflows/js.yml` (format/lint/typecheck/test/build) and
`.github/workflows/php.yml` (pint/phpunit), modeled on the atrellado
repo conventions.
