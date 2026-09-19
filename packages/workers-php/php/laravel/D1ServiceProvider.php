<?php

namespace WorkersPhp\Laravel;

use Illuminate\Support\ServiceProvider;
use WorkersPhp\D1\HttpD1PDO;
use WorkersPhp\Laravel\D1\D1Connection;

// Registers a `d1` database driver whose PDO handle speaks to a D1 query
// endpoint over HTTP instead of a local SQLite file. The endpoint is
// typically a Cloudflare Worker with the D1 binding; any implementation
// of the query/exec protocol works (see WorkersPhp\D1\D1HttpClient).
class D1ServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // The name is set so Connection::getName() works — Migrator::runMethod
        // promotes it to the default connection while a migration runs.
        $this->app['db']->extend('d1', function (array $config, string $name) {
            $config['name'] = $name;

            return new D1Connection(
                new HttpD1PDO($config['endpoint'] ?? ''),
                $config['database'] ?? ':memory:',
                $config['prefix'] ?? '',
                $config
            );
        });
    }
}
