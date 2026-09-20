<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\Queue\QueueHttpClient;

class QueueHttpClientTest extends TestCase
{
    /** @var array<int, array{url: string, body: string}> */
    private array $calls = [];

    private function client(): QueueHttpClient
    {
        return new QueueHttpClient('http://q.app', function (string $method, string $url, array $headers, ?string $body) {
            $this->calls[] = ['url' => $url, 'body' => (string) $body];

            return [200, [], 'ok'];
        });
    }

    public function test_send_posts_text_by_default(): void
    {
        $this->client()->send('raw', 30);

        $this->assertSame('http://q.app/send', $this->calls[0]['url']);
        $this->assertSame(
            ['body' => 'raw', 'contentType' => 'text', 'delaySeconds' => 30],
            json_decode($this->calls[0]['body'], true),
        );
    }

    public function test_send_json_encodes_the_body(): void
    {
        $this->client()->sendJson(['job' => 1]);

        $this->assertSame(
            ['body' => '{"job":1}', 'contentType' => 'json', 'delaySeconds' => null],
            json_decode($this->calls[0]['body'], true),
        );
    }

    public function test_send_batch_posts_the_messages(): void
    {
        $this->client()->sendBatch([
            ['body' => 'a', 'delaySeconds' => 10],
            ['body' => '{"b":2}', 'contentType' => 'json'],
        ]);

        $this->assertSame('http://q.app/sendBatch', $this->calls[0]['url']);
        $this->assertSame(
            ['messages' => [['body' => 'a', 'delaySeconds' => 10], ['body' => '{"b":2}', 'contentType' => 'json']]],
            json_decode($this->calls[0]['body'], true),
        );
    }

    public function test_errors_throw(): void
    {
        $client = new QueueHttpClient('http://q.app', fn () => [500, [], 'boom']);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('HTTP 500');

        $client->send('x');
    }
}
