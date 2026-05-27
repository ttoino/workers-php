<?php
/** @var \WorkersPHP\Env $env */

$name    = trim((string) ($_POST['name'] ?? ''));
$message = trim((string) ($_POST['message'] ?? ''));

if ($name === '' || $message === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "name and message are required\n";
    return;
}

$result = $env->DB->prepare(
    'INSERT INTO Guestbook (name, message) VALUES (:name, :message)'
)->execute([':name' => $name, ':message' => $message])->run();

if (!$result->success) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Failed to write guestbook entry.\n";
    return;
}

header('Location: /', true, 302);
