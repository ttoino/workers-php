<?php

namespace App\Providers;

use Illuminate\Database\SQLiteConnection;
use Illuminate\Support\ServiceProvider;
use WorkersPHP\D1PDO;

class D1ServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app['db']->extend('d1', function (array $config) {
            return new SQLiteConnection(
                new D1PDO($config['binding'] ?? 'DB'),
                $config['database'] ?? ':memory:',
                $config['prefix'] ?? '',
                $config
            );
        });
    }
}
