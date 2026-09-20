# AGENTS.md

## What this is

`workers-php` — a PHP + TypeScript library for running PHP apps on
Cloudflare Workers Containers. The `wasm` branch archives the abandoned
PHP-wasm runtime; `main` is the containers line.

## Layout

The repository root is the publishable package (npm `workers-php`,
composer `workers-php/workers-php`):

- `src/` — TypeScript: outbound protocol handlers (`container.ts`),
  worker fetch handler with boot hold (`worker.ts`)
- `php/base|laravel|symfony/` — the PHP runtime trees (composer
  multi-root PSR-4 map in the root `composer.json`)
- `etc/` — reference `entrypoint.sh` + `Caddyfile`
- `tests/` + `php/tests/` — vitest and phpunit suites
- `examples/laravel` — full Laravel app consuming the root package via
  the pnpm workspace; doubles as the Build check (`wrangler deploy
--dry-run`)

## House rules

- **Commits**: capitalized imperative (`Add the Laravel example`), no
  conventional-commit prefixes; one logical change per commit.
- **Release notes**: backticks for code identifiers, no em-dashes, no
  implementation or dev details; only what consumers need.
- **TypeScript**: arrow functions only (`const f = () => …`), enforced
  by eslint `func-style`; no `function` declarations.
- Formatting: prettier (spaces, width 80, double quotes — see
  `.prettierrc`); sorting via eslint-plugin-perfectionist.
- PHP style: pint with its default (Laravel) preset.

## Checks

```sh
pnpm run format && pnpm run lint        # repo-wide
pnpm run check                          # tsc, root and example
pnpm run test                           # vitest
pnpm run build                          # example wrangler deploy --dry-run
```

- `examples/laravel` typecheck needs its generated
  `worker-configuration.d.ts`: run `pnpm --filter
workers-php-example-laravel run gen:cf-types` after config changes
  (the file is gitignored; CI generates it before `check`).
- PHP side has no host runtime: use docker
  (`docker run --rm -v "$PWD:/app" -w /app
<php-image> sh -c 'vendor/bin/phpunit; vendor/bin/pint --test; vendor/bin/phpstan analyse'`).
- Outbound traffic rides one shared host (`example.com`) with
  per-binding paths (`/DB`); interception happens after DNS resolution,
  so the host must resolve in public DNS — the IANA-reserved apex
  always does. See README § Outbound host.

## CI

`.github/workflows/js.yml` (format/lint/typecheck/test/build) and
`.github/workflows/php.yml` (pint/phpunit), modeled on the atrellado
repo conventions. `.github/workflows/cd.yml` publishes `workers-php` to
npm via OIDC trusted publishing (no tokens): it fires on GitHub releases
and requires the tag to match the root `package.json`'s version.

Releasing: bump the version, commit `Release version X.Y.Z`, push, cut
the GitHub release `vX.Y.Z`. The trusted publisher on npmjs.com points
at `ttoino/workers-php` + `cd.yml`; the initial publish was interactive
because OIDC requires the package to already exist on the registry.
