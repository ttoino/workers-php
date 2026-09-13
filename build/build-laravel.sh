#!/usr/bin/env bash
# Build the Laravel example into dist-laravel/ via the shared framework
# build. Post-step is artisan route:cache (closures are cacheable since
# Laravel 11). No measurable win on this one-route demo (A/B warm median
# ~0.37s both ways) — kept as best practice for when the app grows. No
# config:cache: it bakes absolute build-container paths (view.paths,
# storage dirs) that don't exist at runtime. No view/event cache:
# tarball-excluded / nothing to cache.
set -euo pipefail
exec "$(dirname "$0")/build-framework.sh" \
	examples/laravel public dist-laravel php artisan route:cache
