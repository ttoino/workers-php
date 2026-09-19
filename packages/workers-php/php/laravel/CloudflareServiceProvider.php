<?php

namespace WorkersPhp\Laravel;

use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\ServiceProvider;
use League\Flysystem\Filesystem;
use WorkersPhp\Laravel\Filesystem\R2Adapter;
use WorkersPhp\Symfony\Mailer\HttpMailTransport;

// Registers the `r2` filesystem disk and the `http-mail` mailer, which
// speak plain HTTP to the Cloudflare worker endpoints configured by
// R2_ENDPOINT and MAIL_ENDPOINT.
class CloudflareServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Storage::extend('r2', function ($app, $config) {
            $adapter = new R2Adapter($config['endpoint'] ?? '', $config['url_prefix'] ?? '/storage');

            return new FilesystemAdapter(new Filesystem($adapter), $adapter, $config);
        });

        Mail::extend('http-mail', fn (array $config) => new HttpMailTransport($config['endpoint'] ?? ''));
    }
}
