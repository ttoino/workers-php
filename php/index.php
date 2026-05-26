<?php
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>php-wasm-worker</title>
<style>
  body { font-family: ui-monospace, monospace; max-width: 60ch; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>PHP <?= PHP_VERSION ?> on Cloudflare Workers</h1>
<p>This page was rendered by PHP running as WebAssembly inside a Cloudflare Worker.</p>
<ul>
  <li>SAPI: <code><?= PHP_SAPI ?></code></li>
  <li>uname: <code><?= htmlspecialchars(php_uname()) ?></code></li>
  <li>time: <code><?= date('c') ?></code></li>
  <li>method: <code><?= htmlspecialchars($_SERVER['REQUEST_METHOD'] ?? 'GET') ?></code></li>
  <li>path: <code><?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? '/') ?></code></li>
</ul>
<p>Other routes:</p>
<ul>
  <li><a href="/info">/info</a> &mdash; full <code>phpinfo()</code></li>
  <li><a href="/hello?name=World">/hello?name=World</a> &mdash; query string demo</li>
</ul>
</body>
</html>
