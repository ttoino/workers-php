<?php

namespace WorkersPhp\Hyperdrive;

use WorkersPhp\D1\HttpD1PDO;

/**
 * The same HTTP PDO with a Postgres identity, so Laravel's Postgres
 * grammar runs against a Hyperdrive endpoint. The server version is a
 * constant: Laravel only reads it for feature detection.
 */
class HttpPgsqlPDO extends HttpD1PDO
{
    protected function driverAttributes(): array
    {
        return [
            \PDO::ATTR_DRIVER_NAME => 'pgsql',
            \PDO::ATTR_SERVER_VERSION => '16.0',
        ];
    }
}
