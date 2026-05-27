<?php
/** @var \WorkersPHP\Env $env */

$file = $_FILES['image'] ?? null;
if (!$file || ((int) ($file['error'] ?? 1)) !== 0) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "no image uploaded\n";
    return;
}

$contentType = $file['type'] ?? 'application/octet-stream';
if (!str_starts_with($contentType, 'image/')) {
    http_response_code(415);
    header('Content-Type: text/plain; charset=utf-8');
    echo "expected image/*, got $contentType\n";
    return;
}

$bytes = file_get_contents($file['tmp_name']);
if ($bytes === false) {
    http_response_code(500);
    echo "unable to read upload tmpfile\n";
    return;
}

// Use a deterministic, URL-safe key. (sha1 of bytes keeps duplicates
// idempotent; in a real app you'd add an account/user prefix.)
$ext = match ($contentType) {
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp',
    'image/gif'  => 'gif',
    default      => 'bin',
};
$key = 'uploads/' . sha1($bytes) . '.' . $ext;

$env->IMAGES->put($key, $bytes, ['contentType' => $contentType]);

header('Location: /', true, 302);
