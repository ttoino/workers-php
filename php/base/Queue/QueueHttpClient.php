<?php

namespace WorkersPhp\Queue;

use WorkersPhp\Http\CurlTransport;

/**
 * HTTP client for a Cloudflare Queue endpoint (a Worker with the queue
 * binding). Producing only:
 *
 *   POST {endpoint}/send       {"body": "...", "contentType"?: "text|json", "delaySeconds"?: n}
 *   POST {endpoint}/sendBatch  {"messages": [{"body": "...", ...}]}
 */
final class QueueHttpClient
{
    /** @var callable */
    private $transport;

    public function __construct(public readonly string $endpoint, ?callable $transport = null)
    {
        $this->transport = $transport ?? new CurlTransport;
    }

    public function send(string $body, ?int $delaySeconds = null, string $contentType = 'text'): void
    {
        $this->post('/send', ['body' => $body, 'contentType' => $contentType, 'delaySeconds' => $delaySeconds]);
    }

    /** @param array<string, mixed> $body */
    public function sendJson(array $body, ?int $delaySeconds = null): void
    {
        $this->send((string) json_encode($body), $delaySeconds, 'json');
    }

    /** @param array<array{body: string, contentType?: string, delaySeconds?: int}> $messages */
    public function sendBatch(array $messages): void
    {
        $this->post('/sendBatch', ['messages' => $messages]);
    }

    /** @param array<string, mixed> $payload */
    private function post(string $path, array $payload): void
    {
        [$status, , $body] = ($this->transport)(
            'POST',
            $this->endpoint.$path,
            ['Content-Type: application/json'],
            json_encode($payload),
        );

        if ($status >= 400) {
            throw new \RuntimeException("Queue endpoint error (HTTP $status): ".substr($body, 0, 500));
        }
    }
}
