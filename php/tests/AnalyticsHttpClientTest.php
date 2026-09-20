<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\Analytics\AnalyticsHttpClient;

class AnalyticsHttpClientTest extends TestCase
{
    public function test_write_posts_the_data_point(): void
    {
        $calls = [];
        $client = new AnalyticsHttpClient('http://ae.app', function (string $method, string $url, array $headers, ?string $body) use (&$calls) {
            $calls[] = ['method' => $method, 'url' => $url, 'body' => $body];

            return [200, [], 'ok'];
        });

        $client->write('customer-1', ['Portugal'], [24.5]);

        $this->assertSame('POST', $calls[0]['method']);
        $this->assertSame('http://ae.app/write', $calls[0]['url']);
        $this->assertSame(['index' => 'customer-1', 'blobs' => ['Portugal'], 'doubles' => [24.5]], json_decode($calls[0]['body'], true));
    }

    public function test_write_defaults_to_a_bare_data_point(): void
    {
        $bodies = [];
        $client = new AnalyticsHttpClient('http://ae.app', function ($m, $u, $h, ?string $body) use (&$bodies) {
            $bodies[] = $body;

            return [200, [], 'ok'];
        });

        $client->write();

        $this->assertSame(['index' => null, 'blobs' => [], 'doubles' => []], json_decode($bodies[0], true));
    }

    public function test_errors_throw(): void
    {
        $client = new AnalyticsHttpClient('http://ae.app', fn () => [500, [], 'boom']);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('HTTP 500');

        $client->write();
    }
}
