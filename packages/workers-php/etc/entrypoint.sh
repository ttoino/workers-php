#!/bin/sh
# Reference container entrypoint: boot contract for workers-php.
#
# The contract with the worker is two things — a TCP port that serves
# HTTP, and the ready flag file (WORKERS_PHP_READY_FLAG) that appears
# once the app is safe to serve. Until the flag exists the app answers
# 503 + Retry-After (see WorkersPhp\Laravel\Middleware\WaitForBoot) and
# the worker holds traffic through the window.
#
# Defaults serve FrankenPHP; override SERVER_CMD for any other SAPI.
set -e
cd /app

READY_FLAG="${WORKERS_PHP_READY_FLAG:-/tmp/workers-php-ready}"
SERVER_CMD="${SERVER_CMD:-frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile}"

# Open the port immediately — the runtime health check stops containers
# whose port stays closed, and migrations over HTTP are slow. /ping
# stays 503 until the ready flag exists, so no traffic arrives early.
rm -f "$READY_FLAG"
sh -c "$SERVER_CMD" &
SERVER=$!

# sh as PID 1 does not forward signals; pass SIGTERM along so rollouts
# and sleepAfter stop the server gracefully instead of after SIGKILL.
trap 'kill -TERM $SERVER' TERM

# Laravel housekeeping; plain-PHP apps ship no artisan and skip this.
if [ -f artisan ]; then
    php artisan migrate --force
    php artisan config:cache
    php artisan route:cache
    php artisan view:cache
fi

touch "$READY_FLAG"
wait $SERVER
