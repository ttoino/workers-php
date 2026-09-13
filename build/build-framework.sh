#!/usr/bin/env bash
# Build a composer-based framework example into its dist/ dir: install
# vendor with composer (dockerized — no local PHP toolchain), optionally
# run a framework post-step (e.g. Laravel's route:cache), bundle the app
# tarball, and stage the docroot's statics next to it for ASSETS.
#
# Usage: build-framework.sh <example-dir> <docroot> [post-command...]
set -euo pipefail
cd "$(dirname "$0")/.."

EXAMPLE_DIR=$1
DOCROOT=$2
shift 2
DIST_DIR="$EXAMPLE_DIR/dist"

COMPOSER_CACHE_DIR=${COMPOSER_CACHE_DIR:-$HOME/.cache/composer}
WARP_CA="$HOME/.local/share/cloudflare-warp-certs/CloudflareRootCertificateCombined.pem"
CA_ARGS=()
if [[ -f "$WARP_CA" ]]; then
	CA_ARGS=(-v "$WARP_CA:/warp-ca.pem:ro" -e SSL_CERT_FILE=/warp-ca.pem -e CURL_CA_BUNDLE=/warp-ca.pem)
fi

# 1. Install production dependencies.
docker run --rm \
	-v "$PWD/$EXAMPLE_DIR:/app" \
	-v "$COMPOSER_CACHE_DIR:/tmp/composer-cache" \
	"${CA_ARGS[@]}" \
	-w /app composer:2 \
	composer install --no-dev --optimize-autoloader --no-interaction

# 2. Optional framework post-step (caches, compiled assets, ...).
if [[ $# -gt 0 ]]; then
	docker run --rm \
		-v "$PWD/$EXAMPLE_DIR:/app" \
		"${CA_ARGS[@]}" \
		-w /app composer:2 \
		"$@"
fi

# The container writes root-owned files; hand them back to the user.
docker run --rm -v "$PWD/$EXAMPLE_DIR:/app" -w /app composer:2 \
	chown -R "$(id -u):$(id -g)" vendor composer.lock

# 3. Bundle the app (docroot is the web root; vendor ships in the tarball).
npx workers-php build "./$EXAMPLE_DIR" --out "./$DIST_DIR" --docroot "$DOCROOT" --entrypoint index.php

# 4. Stage docroot statics for ASSETS (PHP files stay tarball-only).
tar -cf - -C "$EXAMPLE_DIR/$DOCROOT" --exclude=index.php . | tar -xf - -C "$DIST_DIR"
