<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\R2\R2HttpClient;

class R2HttpClientTest extends TestCase
{
    /** @var array<int, array<string, mixed>> */
    private array $calls = [];

    /** @param array{0: int, 1: array<string, string>, 2: string} $response */
    private function client(array $response): R2HttpClient
    {
        return new R2HttpClient('http://files.app', function ($m, $u, $h, $b) use ($response) {
            $this->calls[] = ['method' => $m, 'url' => $u, 'headers' => $h, 'body' => $b];

            return $response;
        });
    }

    public function test_get_returns_body_and_headers(): void
    {
        $object = $this->client([200, ['content-type' => 'text/plain'], 'hello'])->get('a.txt');

        $this->assertSame('hello', $object['body']);
        $this->assertSame('http://files.app/a.txt', $this->calls[0]['url']);
    }

    public function test_get_returns_null_on_404(): void
    {
        $this->assertNull($this->client([404, [], ''])->get('missing'));
    }

    public function test_keys_are_url_encoded_but_keep_slashes(): void
    {
        $this->client([404, [], ''])->get('dir/a file.webp');

        $this->assertSame('http://files.app/dir/a%20file.webp', $this->calls[0]['url']);
    }

    public function test_put_sends_body_and_content_type(): void
    {
        $this->client([200, [], 'ok'])->put('a.txt', 'data', 'text/plain');

        $this->assertSame('PUT', $this->calls[0]['method']);
        $this->assertSame('data', $this->calls[0]['body']);
        $this->assertContains('Content-Type: text/plain', $this->calls[0]['headers']);
    }

    public function test_delete_many_posts_a_batch(): void
    {
        $this->client([200, [], 'ok'])->delete('a', 'b', 'c');

        $this->assertSame('DELETE', $this->calls[0]['method']);
        $this->assertSame(['keys' => ['a', 'b', 'c']], json_decode($this->calls[0]['body'], true));
    }

    public function test_list_passes_pagination_params(): void
    {
        $this->client([200, [], json_encode(['objects' => [], 'truncated' => false, 'cursor' => null])])
            ->list('public/', 50, 'cursor-1');

        $this->assertSame('http://files.app/?'.http_build_query(['list' => 1, 'prefix' => 'public/', 'limit' => 50, 'cursor' => 'cursor-1']), $this->calls[0]['url']);
    }

    public function test_server_errors_throw(): void
    {
        $this->expectException(\RuntimeException::class);

        $this->client([500, [], 'boom'])->get('a');
    }
}
