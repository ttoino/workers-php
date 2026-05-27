<?php
// Apache-style front controller for ttoino/feup-ltw-proj.
//
// The original project ran under Apache, which:
//   1. serves /foo/bar.php directly when the file exists,
//   2. resolves /foo/ to /foo/index.php,
//   3. redirects /foo to /foo/ when /foo is a directory,
//   4. otherwise 404s.
//
// This file emulates all four behaviours. workers-php's static-file
// short-circuit (extension list in src/feup-index.ts) handles every
// .css/.js/.webp/etc. directly from the ASSETS binding before we get
// here, so this router only runs for HTML pages and the JSON API.

declare(strict_types=1);

$uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$qpos = strpos($uri, '?');
if ($qpos !== false) {
    $uri = substr($uri, 0, $qpos);
}
$uri = rawurldecode($uri);

// Defense in depth: reject path traversal. Static assets are filtered out
// before reaching this router; only PHP-route requests land here, so a
// blunt check is fine.
if (str_contains($uri, '..')) {
    http_response_code(400);
    echo 'Bad Request';
    return true;
}

$root = __DIR__;
$fs = $root . $uri;

// 1) Exact .php file
if (str_ends_with($uri, '.php') && is_file($fs)) {
    chdir(dirname($fs));
    require $fs;
    return true;
}

// 2) Directory with trailing slash -> index.php inside it
if (str_ends_with($uri, '/') && is_dir($fs) && is_file($fs . 'index.php')) {
    chdir($fs);
    require $fs . 'index.php';
    return true;
}

// 3) Directory without trailing slash -> 301 redirect to with-slash form
if (is_dir($fs)) {
    header('Location: ' . $uri . '/', true, 301);
    return true;
}

// 4) 404, rendered by the project's own error.php (which uses templates).
// error.php pulls $_SESSION['easter-egg'] so a session has to exist.
http_response_code(404);
chdir($root);
if (session_status() === PHP_SESSION_NONE) {
    @session_start();
}
require $root . '/error.php';
return true;
