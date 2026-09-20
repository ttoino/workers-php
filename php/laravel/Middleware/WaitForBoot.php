<?php

namespace WorkersPhp\Laravel\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The container's entrypoint touches the ready flag once it has migrated
 * and primed caches; until then short-circuit with a retryable response
 * so early traffic never hits a half-booted app. The worker holds
 * requests through this window; browsers and API clients get a
 * self-retrying answer.
 */
class WaitForBoot
{
    public function handle(Request $request, Closure $next): Response
    {
        $flag = env('WORKERS_PHP_READY_FLAG', '/tmp/workers-php-ready');

        if (! file_exists($flag)) {
            $body = $request->expectsJson()
                ? response()->json(['message' => 'The application is starting, retry shortly.', 'retry_after' => 3], 503)
                : response(self::page(), 503, ['Content-Type' => 'text/html']);

            return $body->header('Retry-After', 3);
        }

        return $next($request);
    }

    private static function page(): string
    {
        return <<<'HTML'
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta http-equiv="refresh" content="3">
                <title>Starting up…</title>
                <style>
                    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
                </style>
            </head>
            <body>
                <p>Starting up — this page refreshes automatically.</p>
            </body>
            </html>
            HTML;
    }
}
