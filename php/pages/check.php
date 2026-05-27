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

echo "\n=== Request body plumbing ===\n";
$raw = file_get_contents('php://input');
printf("  %-30s %s\n", 'php://input bytes', strlen($raw));
printf("  %-30s %s\n", 'request method', $_SERVER['REQUEST_METHOD'] ?? '');
printf("  %-30s %s\n", '$_POST keys', implode(',', array_keys($_POST)) ?: '(none)');
printf("  %-30s %s\n", '$_FILES keys', implode(',', array_keys($_FILES)) ?: '(none)');
foreach ($_FILES as $name => $f) {
    if (is_array($f['tmp_name'])) {
        foreach ($f['tmp_name'] as $i => $tmp) {
            printf("  files[%s][%d]                  name=%s size=%s exists=%s\n",
                $name, $i, $f['name'][$i], $f['size'][$i],
                file_exists($tmp) ? 'yes' : 'no');
        }
    } else {
        printf("  files[%s]                     name=%s size=%s exists=%s\n",
            $name, $f['name'], $f['size'],
            file_exists($f['tmp_name']) ? 'yes' : 'no');
    }
}

echo "\n=== Stream wrappers ===\n";
foreach (['php://input', 'php://memory', 'php://temp', 'php://stdin'] as $w) {
    $supported = in_array(parse_url($w, PHP_URL_SCHEME), stream_get_wrappers(), true);
    printf("  %-30s %s\n", $w, $supported ? 'OK' : 'MISSING');
}
