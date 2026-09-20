<?php

namespace WorkersPhp\Laravel;

use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\ServiceProvider;
use League\Flysystem\Filesystem;
use WorkersPhp\Hyperdrive\HttpPgsqlPDO;
use WorkersPhp\KV\KVHttpClient;
use WorkersPhp\Laravel\Cache\KVStore;
use WorkersPhp\Laravel\Filesystem\R2Adapter;
use WorkersPhp\Laravel\Hyperdrive\HyperdriveConnection;
use WorkersPhp\Symfony\Mailer\HttpMailTransport;

// Registers the `hyperdrive` database driver, the `r2` filesystem disk,
// the `kv` cache store and the `http-mail` mailer, which speak plain
// HTTP to the Cloudflare worker endpoints configured by
// DB_HYPERDRIVE_ENDPOINT, R2_ENDPOINT, KV_ENDPOINT and MAIL_ENDPOINT.
class CloudflareServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app['db']->extend('hyperdrive', function (array $config, string $name) {
            $config['name'] = $name;

            return new HyperdriveConnection(
                new HttpPgsqlPDO($config['endpoint'] ?? ''),
                $config['database'] ?? '',
                $config['prefix'] ?? '',
                $config
            );
        });
    }

    public function boot(): void
    {
        Storage::extend('r2', function ($app, $config) {
            $adapter = new R2Adapter($config['endpoint'] ?? '', $config['url_prefix'] ?? '/storage');

            return new FilesystemAdapter(new Filesystem($adapter), $adapter, $config);
        });

        Cache::extend('kv', fn ($app, $config) => Cache::repository(
            new KVStore(new KVHttpClient($config['endpoint'] ?? ''), $config['prefix'] ?? ''),
        ));

        Mail::extend('http-mail', fn (array $config) => new HttpMailTransport($config['endpoint'] ?? ''));
    }
}
