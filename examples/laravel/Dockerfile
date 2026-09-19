# Build for the workers-php Laravel example. The wrangler build context
# is the monorepo root so the image can COPY the library's PHP runtime
# into a layout matching the composer's relative PSR-4 paths.
#
# Consumers installing workers-php from npm COPY from
# node_modules/workers-php/... instead and can keep the context at the
# app root.

FROM composer:2 AS vendor
WORKDIR /srv/examples/laravel

# Cloudflare WARP MITMs local builds; the CA bundle is committed for that
# case and simply goes unused on Cloudflare's build infrastructure.
COPY examples/laravel/etc/certs/warp.pem /etc/ssl/warp.pem
ENV SSL_CERT_FILE=/etc/ssl/warp.pem \
    CURL_CA_BUNDLE=/etc/ssl/warp.pem
RUN git config --global --add safe.directory /srv/examples/laravel
COPY examples/laravel/composer.json examples/laravel/composer.lock ./
# Extensions are checked in the runtime stage; the composer image lacks gd.
RUN composer install --no-dev --no-scripts --no-autoloader --ignore-platform-req=ext-gd
COPY examples/laravel/ ./
COPY packages/workers-php/php /srv/packages/workers-php/php
# Local dev trees (vendor/, bootstrap/cache) leak dev packages into the
# image; a full install against the lockfile restores the prod set.
RUN rm -f bootstrap/cache/*.php \
    && composer install --no-dev --optimize-autoloader --classmap-authoritative --ignore-platform-req=ext-gd

FROM dunglas/frankenphp:1-php8.5-bookworm AS runtime
# install-php-extensions skips extensions that are already compiled in.
RUN install-php-extensions gd intl bcmath zip opcache \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

# Plain HTTP on the container's default port; TLS ends at the edge.
ENV SERVER_NAME=:8080
ENV APP_DIR=/srv/examples/laravel

WORKDIR /srv
COPY --from=vendor /srv /srv
COPY packages/workers-php/etc/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
