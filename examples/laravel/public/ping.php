<?php

// Container health check: the runtime pings this before marking the
// container ready; the app answers 503 until its boot flag exists.
$flag = getenv('WORKERS_PHP_READY_FLAG') ?: '/tmp/workers-php-ready';
http_response_code(file_exists($flag) ? 200 : 503);
echo 'pong';
