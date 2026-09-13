<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

class CounterController
{
    #[Route('/', name: 'counter')]
    public function index(): Response
    {
        /** @var \WorkersPHP\Env $env */
        global $env;

        $env->DB->prepare('INSERT INTO page_hits (path) VALUES (?)')
            ->execute(['/'])
            ->run();

        $hits = (int) $env->DB
            ->prepare('SELECT COUNT(*) AS "aggregate" FROM page_hits')
            ->first('aggregate');

        return new Response(<<<HTML
            <!DOCTYPE html>
            <html lang="en">
            <head><meta charset="utf-8"><title>Symfony on workers-php</title></head>
            <body>
                <h1>Stock Symfony 7.</h1>
                <p>Page hits: <strong>{$hits}</strong></p>
            </body>
            </html>
            HTML);
    }
}
