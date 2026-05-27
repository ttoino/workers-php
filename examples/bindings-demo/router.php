<?php
// Tiny front controller for the bindings demo. One file per route.

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

$routes = [
    ['GET',  '/',             'pages/home.php'],
    ['POST', '/guestbook',    'actions/guestbook-add.php'],
    ['POST', '/upload',       'actions/upload-image.php'],
    ['GET',  '/counter',      'pages/counter.php'],
];

foreach ($routes as [$m, $p, $script]) {
    if ($method === $m && $path === $p) {
        require __DIR__ . '/' . $script;
        return;
    }
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo "Not Found: $method $path\n";
