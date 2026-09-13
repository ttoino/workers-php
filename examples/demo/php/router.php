<?php
// Tiny front controller for the workers-php demo. Each route delegates
// to a `pages/<name>.php` file. The `workers-php` library invokes this
// once per request with $_SERVER/$_GET/$_POST/$_COOKIE/$_REQUEST seeded
// from the incoming HTTP request.

$path = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($path, PHP_URL_PATH) ?: '/';

$routes = [
    '/'          => 'pages/index.php',
    '/index.php' => 'pages/index.php',
    '/info'      => 'pages/info.php',
    '/info.php'  => 'pages/info.php',
    '/hello'     => 'pages/hello.php',
    '/hello.php' => 'pages/hello.php',
    '/check'     => 'pages/check.php',
];

if (!isset($routes[$path])) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "404 — no route for $path\n";
    return;
}

require __DIR__ . '/' . $routes[$path];
