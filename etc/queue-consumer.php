<?php

use WorkersPhp\Laravel\Queue\QueueConsumer;

// Internal queue consumer endpoint. It listens on a second port that is
// never routed publicly (8081 by default); the app worker forwards
// Cloudflare Queue messages here one at a time and maps the response to
// ack/retry semantics.

$appDir = getenv('APP_DIR') ?: '/srv/app';

require $appDir.'/vendor/autoload.php';
$app = require $appDir.'/bootstrap/app.php';

$envelope = json_decode((string) file_get_contents('php://input'), true) ?? [];
$body = $envelope['body'] ?? '';

$result = (new QueueConsumer($app))->consume(
    is_array($body) ? (string) json_encode($body) : (string) $body,
    (string) ($envelope['id'] ?? ''),
    (int) ($envelope['attempts'] ?? 1),
);

http_response_code($result['status']);
if ($result['delay'] !== null) {
    header('X-Queue-Delay: '.$result['delay']);
}
echo 'ok';
