<?php
header('Content-Type: text/plain; charset=utf-8');
echo "PHP " . PHP_VERSION . "\n\n";
echo "=== Loaded extensions ===\n";
foreach (get_loaded_extensions() as $ext) {
    echo "  $ext\n";
}
echo "\n=== Laravel requirements ===\n";
$required = ['ctype', 'curl', 'dom', 'fileinfo', 'filter', 'hash', 'mbstring', 'openssl', 'pcre', 'pdo', 'session', 'tokenizer', 'xml'];
foreach ($required as $ext) {
    $loaded = extension_loaded($ext);
    printf("  %-12s %s\n", $ext, $loaded ? 'OK' : 'MISSING');
}
echo "\n=== Some key functions ===\n";
$fns = ['mb_strlen', 'mb_internal_encoding', 'iconv', 'curl_init', 'finfo_open', 'openssl_random_pseudo_bytes', 'random_bytes', 'preg_match', 'json_encode'];
foreach ($fns as $fn) {
    printf("  %-30s %s\n", $fn, function_exists($fn) ? 'OK' : 'MISSING');
}
