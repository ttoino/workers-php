<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\KV\KVHttpClient;
use WorkersPhp\Laravel\Cache\KVStore;

class KVStoreTest extends TestCase
{
    /** @var array<string, array{value: string, ttl: ?int}> */
    private array $data = [];

    private function store(string $prefix = ''): KVStore
    {
        $transport = function (string $method, string $url, array $headers, ?string $body) {
            $path = (string) parse_url($url, PHP_URL_PATH);
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $key = rawurldecode((string) substr($path, 1));

            if (isset($query['list'])) {
                $keys = [];
                foreach ($this->data as $name => $entry) {
                    if (str_starts_with($name, (string) ($query['prefix'] ?? ''))) {
                        $keys[] = ['name' => $name, 'expiration' => $entry['ttl'] !== null ? time() + $entry['ttl'] : null, 'metadata' => null];
                    }
                }

                return [200, [], json_encode(['keys' => $keys, 'list_complete' => true, 'cursor' => null])];
            }

            return match ($method) {
                'GET' => isset($this->data[$key])
                    ? [200, [], $this->data[$key]['value']]
                    : [404, [], 'Not found'],
                'PUT' => $this->put($key, $body, $headers),
                'DELETE' => $this->forget($key),
                default => [405, [], ''],
            };
        };

        return new KVStore(new KVHttpClient('http://kv.app', $transport), $prefix);
    }

    /**
     * @param  string[]  $headers
     * @return array{0: int, 1: array<string, string>, 2: string}
     */
    private function put(string $key, ?string $body, array $headers): array
    {
        $ttl = null;
        foreach ($headers as $header) {
            if (str_starts_with($header, 'X-KV-Expiration-Ttl: ')) {
                $ttl = (int) substr($header, 21);
            }
        }
        $this->data[$key] = ['value' => (string) $body, 'ttl' => $ttl];

        return [200, [], 'ok'];
    }

    /** @return array{0: int, 1: array<string, string>, 2: string} */
    private function forget(string $key): array
    {
        unset($this->data[$key]);

        return [200, [], 'ok'];
    }

    public function test_put_and_get_roundtrip(): void
    {
        $store = $this->store('cache:');
        $store->put('a', '1', 60);

        $this->assertSame('1', $store->get('a'));
        $this->assertSame(['value' => '1', 'ttl' => 60], $this->data['cache:a']);
    }

    public function test_forever_stores_without_a_ttl(): void
    {
        $store = $this->store();
        $store->forever('a', '1');

        $this->assertSame(['value' => '1', 'ttl' => null], $this->data['a']);
    }

    public function test_increment_preserves_the_ttl(): void
    {
        $store = $this->store();
        $store->put('counter', '1', 300);

        $this->assertSame(2, $store->increment('counter'));
        $this->assertSame(300, $this->data['counter']['ttl']);
    }

    public function test_increment_fails_on_missing_or_non_numeric_values(): void
    {
        $store = $this->store();

        $this->assertFalse($store->increment('missing'));

        $store->put('text', 'abc', 60);
        $this->assertFalse($store->increment('text'));
    }

    public function test_flush_deletes_every_prefixed_key(): void
    {
        $store = $this->store('cache:');
        $store->put('a', '1', 60);
        $store->put('b', '2', 60);
        $this->data['other'] = ['value' => '3', 'ttl' => null];

        $store->flush();

        $this->assertSame(['other'], array_keys($this->data));
    }
}
