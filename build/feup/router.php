<?php
// Apache-style front controller for ttoino/feup-ltw-proj.
//
// Emulates Apache's rules: serve /foo/bar.php directly, resolve /foo/ to
// index.php, redirect /foo to /foo/ for directories, otherwise 404.
//
// Static files are short-circuited to ASSETS before this runs (extension
// list in src/feup-index.ts), so only HTML pages and the JSON API land
// here.

declare(strict_types=1);

$uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$qpos = strpos($uri, '?');
if ($qpos !== false) {
    $uri = substr($uri, 0, $qpos);
}
$uri = rawurldecode($uri);

// Defense in depth: reject path traversal.
if (str_contains($uri, '..')) {
    http_response_code(400);
    echo 'Bad Request';
    return true;
}

$root = __DIR__;
$fs = $root . $uri;

if (str_ends_with($uri, '.php') && is_file($fs)) {
    chdir(dirname($fs));
    require $fs;
    return true;
}

if (str_ends_with($uri, '/') && is_dir($fs) && is_file($fs . 'index.php')) {
    chdir($fs);
    require $fs . 'index.php';
    return true;
}

if (is_dir($fs)) {
    header('Location: ' . $uri . '/', true, 301);
    return true;
}

// error.php pulls $_SESSION['easter-egg'], so a session has to exist.
http_response_code(404);
chdir($root);
if (session_status() === PHP_SESSION_NONE) {
    @session_start();
}
require $root . '/error.php';
return true;
