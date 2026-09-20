<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\Mail\MailHttpClient;

class MailHttpClientTest extends TestCase
{
    public function test_send_posts_the_structured_payload(): void
    {
        $calls = [];
        $client = new MailHttpClient('http://email.app', function ($m, $u, $h, $b) use (&$calls) {
            $calls[] = ['url' => $u, 'body' => json_decode($b, true)];

            return [200, [], 'sent'];
        });

        $client->send('noreply@x.dev', ['a@x.dev', 'b@x.dev'], 'Hi', '<b>x</b>', 'x');

        $this->assertSame('http://email.app/send', $calls[0]['url']);
        $this->assertSame([
            'from' => 'noreply@x.dev',
            'to' => ['a@x.dev', 'b@x.dev'],
            'subject' => 'Hi',
            'html' => '<b>x</b>',
            'text' => 'x',
        ], $calls[0]['body']);
    }

    public function test_send_omits_missing_bodies(): void
    {
        $calls = [];
        $client = new MailHttpClient('http://email.app', function ($m, $u, $h, $b) use (&$calls) {
            $calls[] = json_decode($b, true);

            return [200, [], 'sent'];
        });

        $client->send('noreply@x.dev', ['a@x.dev'], 'Hi');

        $this->assertArrayNotHasKey('html', $calls[0]);
        $this->assertArrayNotHasKey('text', $calls[0]);
    }

    public function test_errors_throw(): void
    {
        $this->expectException(\RuntimeException::class);

        $client = new MailHttpClient('http://email.app', fn () => [400, [], 'sender not allowed']);
        $client->send('bad@x.dev', ['a@x.dev'], 'Hi');
    }
}
