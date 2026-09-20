<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\Laravel\Queue\CfQueue;
use WorkersPhp\Queue\QueueHttpClient;

class CfQueueTest extends TestCase
{
    /** @var array<int, array{url: string, body: array<string, mixed>}> */
    private array $calls = [];

    private function queue(): CfQueue
    {
        $client = new QueueHttpClient('http://q.app', function ($method, $url, $headers, ?string $body) {
            $this->calls[] = ['url' => $url, 'body' => (array) json_decode((string) $body, true)];

            return [200, [], 'ok'];
        });

        return new CfQueue($client);
    }

    public function test_push_sends_a_json_payload(): void
    {
        $this->queue()->push('App\\Jobs\\SendMail', ['to' => 'a@b.c']);

        $call = $this->calls[0];

        $this->assertSame('http://q.app/send', $call['url']);
        $this->assertSame('json', $call['body']['contentType']);
        $this->assertNull($call['body']['delaySeconds']);

        $payload = json_decode($call['body']['body'], true);
        $this->assertSame('App\\Jobs\\SendMail', $payload['displayName']);
    }

    public function test_later_sets_the_delay(): void
    {
        $this->queue()->later(45, 'App\\Jobs\\SendMail');

        $this->assertSame(45, $this->calls[0]['body']['delaySeconds']);
    }

    public function test_push_raw_honours_options_delay(): void
    {
        $this->queue()->pushRaw('{"raw":1}', null, ['delay' => 5]);

        $this->assertSame(['body' => '{"raw":1}', 'contentType' => 'json', 'delaySeconds' => 5], $this->calls[0]['body']);
    }

    public function test_bulk_batches_payloads(): void
    {
        $this->queue()->bulk(['App\\Jobs\\One', 'App\\Jobs\\Two']);

        $call = $this->calls[0];

        $this->assertSame('http://q.app/sendBatch', $call['url']);
        $this->assertCount(2, $call['body']['messages']);
        $this->assertSame('json', $call['body']['messages'][0]['contentType']);
    }

    public function test_pop_throws(): void
    {
        $this->expectException(\LogicException::class);

        $this->queue()->pop();
    }

    public function test_size_is_always_zero(): void
    {
        $this->assertSame(0, $this->queue()->size());
    }
}
