#!/usr/bin/env bash
# Build the Laravel example into dist-laravel/: install vendor with
# composer (dockerized — no local PHP toolchain), bundle the app tarball,
# and stage public/ statics next to it for the ASSETS binding.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSER_CACHE_DIR=${COMPOSER_CACHE_DIR:-$HOME/.cache/composer}
WARP_CA="$HOME/.local/share/cloudflare-warp-certs/CloudflareRootCertificateCombined.pem"
CA_ARGS=()
if [[ -f "$WARP_CA" ]]; then
	CA_ARGS=(-v "$WARP_CA:/warp-ca.pem:ro" -e SSL_CERT_FILE=/warp-ca.pem -e CURL_CA_BUNDLE=/warp-ca.pem)
fi

# 1. Install production dependencies (fresh: cached config references
# packages that must not linger between builds).
docker run --rm \
	-v "$PWD/examples/laravel:/app" \
	-v "$COMPOSER_CACHE_DIR:/tmp/composer-cache" \
	"${CA_ARGS[@]}" \
	-w /app composer:2 \
	composer install --no-dev --optimize-autoloader --no-interaction

# 2. Route cache: per-request boot skips loading routes/*.php (closures
# are cacheable since Laravel 11). No measurable win on this one-route
# demo (A/B warm median ~0.37s both ways) — kept as best practice for
# when the app grows. No config:cache: it bakes absolute build-container
# paths (view.paths, storage dirs) that don't exist at runtime. No
# view/event cache: tarball-excluded / nothing to cache.
docker run --rm \
	-v "$PWD/examples/laravel:/app" \
	"${CA_ARGS[@]}" \
	-w /app composer:2 \
	php artisan route:cache

# The container writes root-owned files; hand them back to the user.
docker run --rm -v "$PWD/examples/laravel:/app" -w /app composer:2 \
	chown -R "$(id -u):$(id -g)" vendor composer.lock bootstrap/cache

# 3. Bundle the app (public/ is the docroot; vendor ships in the tarball).
npx workers-php build ./examples/laravel --out ./dist-laravel --docroot public --entrypoint index.php

# 4. Stage public/ statics for ASSETS (PHP files stay tarball-only).
mkdir -p dist-laravel
tar -cf - -C examples/laravel/public --exclude=index.php . | tar -xf - -C dist-laravel
