<?php
/** @var \WorkersPHP\Env $env */

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;

require __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

$app->addErrorMiddleware(false, true, true);

$app->get('/', function (Request $request, Response $response) use ($env) {
    $env->DB->prepare('INSERT INTO page_hits (path) VALUES (?)')
        ->execute([$request->getUri()->getPath()])
        ->run();

    $hits = (int) $env->DB
        ->prepare('SELECT COUNT(*) AS "aggregate" FROM page_hits')
        ->first('aggregate');

    $response->getBody()->write(<<<HTML
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="utf-8"><title>Slim on workers-php</title></head>
        <body>
            <h1>Stock Slim 4.</h1>
            <p>Page hits: <strong>{$hits}</strong></p>
        </body>
        </html>
        HTML);
    return $response->withHeader('Content-Type', 'text/html; charset=utf-8');
});

$app->run();
