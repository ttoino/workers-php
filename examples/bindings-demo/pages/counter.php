<?php
/** @var \WorkersPHP\Env $env */
$key = $_GET['key'] ?? 'counter';
$key = preg_replace('/[^a-zA-Z0-9_:.-]/', '', (string) $key);
if ($key === '') $key = 'counter';

$current = (int) ($env->KV->get($key) ?? '0');
$next = $current + 1;
$env->KV->put($key, (string) $next);

header('Content-Type: text/plain; charset=utf-8');
echo "key:   $key\n";
echo "value: $next\n";
echo "\n";
echo "Try: /counter?key=alpha, /counter?key=beta, etc.\n";
