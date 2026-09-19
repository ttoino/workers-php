<?php

use App\Providers\AppServiceProvider;
use WorkersPhp\Laravel\CloudflareServiceProvider;
use WorkersPhp\Laravel\D1ServiceProvider;

return [
    AppServiceProvider::class,
    CloudflareServiceProvider::class,
    D1ServiceProvider::class,
];
