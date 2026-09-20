<?php

namespace WorkersPhp\KV;

use WorkersPhp\Http\CurlTransport;

/**
 * HTTP client for a KV namespace endpoint (a Worker with the KV
 * binding). Keys map to URL paths; listing goes through query params:
 *
 *   GET    /{key}                         → value body (+ X-KV-Metadata header)
 *   PUT    /{key}                         → store (+ X-KV-Metadata, X-KV-Expiration-Ttl)
 *   DELETE /{key}                         → delete (one request per key)
 *   GET    /?list&prefix&limit&cursor     → {"keys": [...], "list_complete": bool, "cursor": ?string}
 */
final class KVHttpClient
{
    /** @var callable */
    private $transport;

    public function __construct(public readonly string $endpoint, ?callable $transport = null)
    {
        $this->transport = $transport ?? new CurlTransport;
    }

    /** @return array{value: string, metadata: array<string, mixed>|null}|null null when the key does not exist */
    public function get(string $key): ?array
    {
        [$status, $headers, $body] = $this->request('GET', $this->keyPath($key));
        if ($status === 404) {
            return null;
        }

        $metadata = $headers['x-kv-metadata'] ?? null;

        return ['value' => $body, 'metadata' => $metadata !== null ? json_decode($metadata, true) : null];
    }

    /** Value only; null when the key does not exist. */
    public function getValue(string $key): ?string
    {
        return $this->get($key)['value'] ?? null;
    }

    /** @param array<string, mixed>|null $metadata */
    public function put(string $key, string $value, ?int $ttl = null, ?array $metadata = null): void
    {
        $headers = [];
        if ($ttl !== null) {
            $headers[] = 'X-KV-Expiration-Ttl: '.$ttl;
        }
        if ($metadata !== null) {
            $headers[] = 'X-KV-Metadata: '.json_encode($metadata);
        }
        $this->request('PUT', $this->keyPath($key), $value, $headers);
    }

    public function delete(string ...$keys): void
    {
        foreach ($keys as $key) {
            $this->request('DELETE', $this->keyPath($key));
        }
    }

    /** @return array{keys: array<int, array{name: string, expiration: int|null, metadata: array<string, mixed>|null}>, list_complete: bool, cursor: string|null} */
    public function list(string $prefix = '', int $limit = 1000, ?string $cursor = null): array
    {
        $query = ['list' => 1, 'prefix' => $prefix, 'limit' => $limit];
        if ($cursor) {
            $query['cursor'] = $cursor;
        }
        [, , $body] = $this->request('GET', '/?'.http_build_query($query));

        return json_decode($body, true);
    }

    private function keyPath(string $key): string
    {
        return '/'.str_replace('%2F', '/', rawurlencode(ltrim($key, '/')));
    }

    /**
     * @param  string[]  $headers
     * @return array{0: int, 1: array<string, string>, 2: string}
     */
    private function request(string $method, string $path, ?string $body = null, array $headers = []): array
    {
        [$status, $responseHeaders, $responseBody] = ($this->transport)($method, $this->endpoint.$path, $headers, $body);

        if ($status >= 400 && $status !== 404) {
            throw new \RuntimeException("KV endpoint error (HTTP $status): ".substr($responseBody, 0, 500));
        }

        return [$status, $responseHeaders, $responseBody];
    }
}
