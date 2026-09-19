<?php

namespace WorkersPhp\Tests;

use PHPUnit\Framework\TestCase;
use WorkersPhp\D1\D1HttpClient;
use WorkersPhp\D1\HttpD1PDO;

class D1HttpClientTest extends TestCase
{
    private array $calls = [];

    private function client(?array $response = null): D1HttpClient
    {
        $transport = function (string $method, string $url, array $headers, ?string $body) use ($response) {
            $this->calls[] = ['method' => $method, 'url' => $url, 'body' => json_decode($body, true)];

            return $response ?? [200, [], json_encode(['results' => [], 'success' => true, 'meta' => []])];
        };

        return new D1HttpClient('http://db.app', $transport);
    }

    public function test_query_posts_sql_and_positional_params(): void
    {
        $this->client()->query('SELECT * FROM users WHERE id = ? AND name = ?', [7, 'x']);

        $this->assertSame('POST', $this->calls[0]['method']);
        $this->assertSame('http://db.app/query', $this->calls[0]['url']);
        $this->assertSame(['sql' => 'SELECT * FROM users WHERE id = ? AND name = ?', 'params' => [7, 'x']], $this->calls[0]['body']);
    }

    public function test_query_rewrites_named_placeholders_in_order(): void
    {
        $this->client()->query(
            'UPDATE users SET name = :name WHERE id = :id OR manager_id = :id',
            ['id' => 7, 'name' => 'x'],
        );

        $this->assertSame(
            ['sql' => 'UPDATE users SET name = ? WHERE id = ? OR manager_id = ?', 'params' => ['x', 7, 7]],
            $this->calls[0]['body'],
        );
    }

    public function test_query_leaves_placeholders_inside_strings_alone(): void
    {
        $this->client()->query("SELECT ':not_a_param' AS literal, :real AS value", ['real' => 1]);

        $this->assertSame(
            ['sql' => "SELECT ':not_a_param' AS literal, ? AS value", 'params' => [1]],
            $this->calls[0]['body'],
        );
    }

    public function test_exec_posts_to_exec_and_returns_count(): void
    {
        $client = $this->client([200, [], json_encode(['count' => 3])]);

        $this->assertSame(3, $client->exec('CREATE TABLE a (id int); CREATE TABLE b (id int)'));
        $this->assertSame('http://db.app/exec', $this->calls[0]['url']);
    }

    public function test_http_errors_throw(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/HTTP 500/');

        $this->client([500, [], 'boom'])->query('SELECT 1');
    }

    public function test_error_payloads_throw(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('no such table');

        $this->client([200, [], json_encode(['error' => 'no such table'])])->query('SELECT 1');
    }

    public function test_pdo_query_fetches_assoc_rows(): void
    {
        $client = new D1HttpClient('http://db.app', function () {
            return [200, [], json_encode([
                'results' => [['id' => 1, 'name' => 'probe']],
                'success' => true,
                'meta' => ['last_row_id' => 9, 'changes' => 1],
            ])];
        });
        $pdo = new HttpD1PDO($client);

        $this->assertSame([['id' => 1, 'name' => 'probe']], $pdo->query('SELECT * FROM users')->fetchAll());
        $this->assertSame('9', $pdo->lastInsertId());
    }

    public function test_pdo_statement_binds_named_params(): void
    {
        $calls = [];
        $client = new D1HttpClient('http://db.app', function ($m, $u, $h, $b) use (&$calls) {
            $calls[] = json_decode($b, true);

            return [200, [], json_encode(['results' => [], 'success' => true, 'meta' => []])];
        });
        $pdo = new HttpD1PDO($client);

        $statement = $pdo->prepare('SELECT * FROM users WHERE id = :id');
        $statement->execute(['id' => 42]);

        $this->assertSame(['sql' => 'SELECT * FROM users WHERE id = ?', 'params' => [42]], $calls[0]);
    }
}
