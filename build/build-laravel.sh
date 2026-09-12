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

# 1. Install production dependencies.
docker run --rm \
	-v "$PWD/examples/laravel:/app" \
	-v "$COMPOSER_CACHE_DIR:/tmp/composer-cache" \
	"${CA_ARGS[@]}" \
	-w /app composer:2 \
	composer install --no-dev --optimize-autoloader --no-interaction

# The container writes root-owned files; hand them back to the user.
docker run --rm -v "$PWD/examples/laravel:/app" -w /app composer:2 \
	chown -R "$(id -u):$(id -g)" vendor composer.lock

# 2. Bundle the app (public/ is the docroot; vendor ships in the tarball).
npx workers-php build ./examples/laravel --out ./dist-laravel --docroot public --entrypoint index.php

# 3. Stage public/ statics for ASSETS (PHP files stay tarball-only).
mkdir -p dist-laravel
tar -cf - -C examples/laravel/public --exclude=index.php . | tar -xf - -C dist-laravel
