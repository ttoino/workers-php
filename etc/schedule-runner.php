<?php

use Illuminate\Contracts\Console\Kernel;

// Internal scheduler endpoint. It listens on the same internal port as
// the queue consumer (8081 by default); the app worker forwards Cloudflare
// Cron Triggers here, and the response status only reports whether the
// schedule run itself succeeded — individual scheduled tasks log their
// own failures.

$appDir = getenv('APP_DIR') ?: '/app';

require $appDir.'/vendor/autoload.php';
$app = require $appDir.'/bootstrap/app.php';

try {
    $kernel = $app->make(Kernel::class);
    $status = $kernel->call('schedule:run');
    http_response_code($status === 0 ? 200 : 500);
    echo $kernel->output();
} catch (Throwable $e) {
    http_response_code(500);
    echo $e->getMessage();
}
