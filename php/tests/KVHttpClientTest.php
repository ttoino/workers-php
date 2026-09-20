<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\KV\KVHttpClient;

class KVHttpClientTest extends TestCase
{
    /** @var array<int, array<string, mixed>> */
    private array $calls = [];

    /** @param array{0: int, 1: array<string, string>, 2: string}|null $response */
    private function client(?array $response = null): KVHttpClient
    {
        $transport = function (string $method, string $url, array $headers, ?string $body) use ($response) {
            $this->calls[] = ['method' => $method, 'url' => $url, 'headers' => $headers, 'body' => $body];

            return $response ?? [200, [], 'ok'];
        };

        return new KVHttpClient('http://kv.app', $transport);
    }

    public function test_put_sends_value_ttl_and_metadata(): void
    {
        $this->client()->put('k', 'v', 120, ['tag' => 'a']);

        $put = $this->calls[0];

        $this->assertSame('PUT', $put['method']);
        $this->assertSame('http://kv.app/k', $put['url']);
        $this->assertSame('v', $put['body']);
        $this->assertContains('X-KV-Expiration-Ttl: 120', $put['headers']);
        $this->assertContains('X-KV-Metadata: {"tag":"a"}', $put['headers']);
    }

    public function test_get_returns_value_and_metadata(): void
    {
        $client = $this->client([200, ['x-kv-metadata' => '{"tag":"a"}'], 'v']);

        $this->assertSame(['value' => 'v', 'metadata' => ['tag' => 'a']], $client->get('k'));
        $this->assertSame('v', $client->getValue('k'));
    }

    public function test_get_returns_null_on_404(): void
    {
        $client = $this->client([404, [], 'Not found']);

        $this->assertNull($client->get('nope'));
        $this->assertNull($client->getValue('nope'));
    }

    public function test_delete_loops_over_keys(): void
    {
        $this->client()->delete('a', 'b');

        $this->assertSame(['DELETE', 'DELETE'], array_column($this->calls, 'method'));
        $this->assertSame('http://kv.app/b', $this->calls[1]['url']);
    }

    public function test_list_builds_the_query_string(): void
    {
        $page = ['keys' => [['name' => 'app/a', 'expiration' => null, 'metadata' => null]], 'list_complete' => true, 'cursor' => null];
        $client = $this->client([200, [], json_encode($page)]);

        $this->assertSame($page, $client->list('app/', 100, 'cursor-1'));
        $this->assertSame('http://kv.app/?list=1&prefix=app%2F&limit=100&cursor=cursor-1', $this->calls[0]['url']);
    }
}
