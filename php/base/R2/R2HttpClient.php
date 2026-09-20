<?php

namespace WorkersPhp\R2;

use WorkersPhp\Http\CurlTransport;

/**
 * HTTP client for an R2 bucket endpoint (a Worker with the bucket
 * binding). Keys map to URL paths; listing goes through query params:
 *
 *   GET    /{key}                         → object body
 *   HEAD   /{key}                         → metadata headers
 *   PUT    /{key}                         → store
 *   DELETE /{key}                         → delete one
 *   DELETE /            {"keys": [...]}   → delete a batch
 *   GET    /?list&prefix&limit&cursor     → {"objects": [...], "truncated": bool, "cursor": ?string}
 */
final class R2HttpClient
{
    /** @var callable */
    private $transport;

    public function __construct(public readonly string $endpoint, ?callable $transport = null)
    {
        $this->transport = $transport ?? new CurlTransport;
    }

    /** @return array{headers: array<string, string>, body: string}|null null when the key does not exist */
    public function get(string $key): ?array
    {
        [$status, $headers, $body] = $this->request('GET', $this->keyPath($key));

        return $status === 404 ? null : ['headers' => $headers, 'body' => $body];
    }

    /** @return array<string, string>|null response headers, null when the key does not exist */
    public function head(string $key): ?array
    {
        [$status, $headers] = $this->request('HEAD', $this->keyPath($key));

        return $status === 404 ? null : $headers;
    }

    public function put(string $key, string $body, ?string $contentType = null): void
    {
        $this->request('PUT', $this->keyPath($key), $body, $contentType ? ['Content-Type: '.$contentType] : []);
    }

    public function delete(string ...$keys): void
    {
        if (count($keys) === 1) {
            $this->request('DELETE', $this->keyPath($keys[0]));

            return;
        }

        $this->request('DELETE', '/', json_encode(['keys' => array_values($keys)]), ['Content-Type: application/json']);
    }

    /** @return array{objects: array<int, array{key: string, size: int}>, truncated: bool, cursor: ?string} */
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
            throw new \RuntimeException("R2 endpoint error (HTTP $status): ".substr($responseBody, 0, 500));
        }

        return [$status, $responseHeaders, $responseBody];
    }
}
