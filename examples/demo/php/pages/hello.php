<?php
header('Content-Type: text/plain; charset=utf-8');
$name = $_REQUEST['name'] ?? 'world';
echo "hello, " . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . "!\n";
echo "method: " . ($_SERVER['REQUEST_METHOD'] ?? '?') . "\n";
echo "GET (" . count($_GET) . "):\n";
foreach ($_GET as $k => $v) {
    echo "  $k = $v\n";
}
echo "POST (" . count($_POST) . "):\n";
foreach ($_POST as $k => $v) {
    echo "  $k = $v\n";
}
