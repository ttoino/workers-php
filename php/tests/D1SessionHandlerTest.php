<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\D1\D1HttpClient;
use WorkersPhp\Session\D1SessionHandler;

class D1SessionHandlerTest extends TestCase
{
    /** @var array<int, array<string, mixed>> */
    private array $calls = [];

    private function handler(): D1SessionHandler
    {
        $transport = function (string $method, string $url, array $headers, ?string $body) {
            $this->calls[] = ['url' => $url, 'body' => json_decode($body, true)];

            $sql = $this->calls[count($this->calls) - 1]['body']['sql'] ?? '';

            if (str_starts_with($sql, 'SELECT')) {
                return [200, [], json_encode(['results' => [['data' => 'serialized']], 'success' => true, 'meta' => []])];
            }

            return [200, [], json_encode(['results' => [], 'success' => true, 'meta' => []])];
        };

        return new D1SessionHandler(new D1HttpClient('http://db.app', $transport));
    }

    public function test_constructor_creates_the_table_once(): void
    {
        $this->handler();
        $this->handler();

        $sqls = array_column(array_column($this->calls, 'body'), 'sql');

        $this->assertSame(
            ['CREATE TABLE IF NOT EXISTS "sessions" (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)',
                'CREATE INDEX IF NOT EXISTS "sessions_expires" ON "sessions" (expires)'],
            $sqls,
        );
    }

    public function test_write_upserts_with_an_expiry(): void
    {
        $this->handler()->write('abc', 'payload');

        $write = end($this->calls)['body'];

        $this->assertStringContainsString('ON CONFLICT(id) DO UPDATE', $write['sql']);
        $this->assertSame('abc', $write['params'][0]);
        $this->assertSame('payload', $write['params'][1]);
        $this->assertGreaterThan(time(), $write['params'][2]);
    }

    public function test_read_returns_live_rows_only(): void
    {
        $this->assertSame('serialized', $this->handler()->read('abc'));

        $read = end($this->calls)['body'];

        $this->assertStringContainsString('expires > ?', $read['sql']);
        $this->assertSame('abc', $read['params'][0]);
    }

    public function test_destroy_and_gc_delete_rows(): void
    {
        $handler = $this->handler();
        $handler->destroy('abc');
        $handler->gc(1440);

        $sqls = array_column(array_column($this->calls, 'body'), 'sql');

        $this->assertContains('DELETE FROM "sessions" WHERE id = ?', $sqls);
        $this->assertContains('DELETE FROM "sessions" WHERE expires <= ?', $sqls);
    }
}
