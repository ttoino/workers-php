<?php

namespace WorkersPhp\Analytics;

use WorkersPhp\Http\CurlTransport;

/**
 * HTTP client for an Analytics Engine endpoint (a Worker with the
 * dataset binding). One data point per call: up to 20 blobs (16 KB
 * total), 20 doubles and one index of at most 96 bytes.
 */
final class AnalyticsHttpClient
{
    /** @var callable */
    private $transport;

    public function __construct(public readonly string $endpoint, ?callable $transport = null)
    {
        $this->transport = $transport ?? new CurlTransport;
    }

    /**
     * @param  string[]  $blobs
     * @param  float[]  $doubles
     */
    public function write(?string $index = null, array $blobs = [], array $doubles = []): void
    {
        [$status, , $body] = ($this->transport)(
            'POST',
            $this->endpoint.'/write',
            ['Content-Type: application/json'],
            json_encode(['index' => $index, 'blobs' => $blobs, 'doubles' => $doubles]),
        );

        if ($status >= 400) {
            throw new \RuntimeException("Analytics endpoint error (HTTP $status): ".substr($body, 0, 500));
        }
    }
}
