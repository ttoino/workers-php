<?php

namespace WorkersPhp\Tests;

use Illuminate\Database\Query\Grammars\PostgresGrammar;
use PHPUnit\Framework\TestCase;
use WorkersPhp\D1\D1HttpClient;
use WorkersPhp\D1\HttpD1PDO;
use WorkersPhp\Hyperdrive\HttpPgsqlPDO;
use WorkersPhp\Laravel\Hyperdrive\HyperdriveConnection;

class HttpPgsqlPDOTest extends TestCase
{
    private function client(): D1HttpClient
    {
        return new D1HttpClient('http://pg.app', fn ($m, $u, $h, $b) => [200, [], json_encode(['results' => [], 'success' => true, 'meta' => []])]);
    }

    public function test_pgsql_driver_identity(): void
    {
        $pdo = new HttpPgsqlPDO($this->client());

        $this->assertSame('pgsql', $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME));
        $this->assertSame('16.0', $pdo->getAttribute(\PDO::ATTR_SERVER_VERSION));
        $this->assertSame(\PDO::ERRMODE_EXCEPTION, $pdo->getAttribute(\PDO::ATTR_ERRMODE));
    }

    public function test_d1_driver_identity_is_unchanged(): void
    {
        $pdo = new HttpD1PDO($this->client());

        $this->assertSame('sqlite', $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME));
        $this->assertSame('3.40.0', $pdo->getAttribute(\PDO::ATTR_SERVER_VERSION));
    }

    public function test_connection_uses_the_postgres_grammar(): void
    {
        $connection = new HyperdriveConnection(
            new HttpPgsqlPDO($this->client()),
            'app',
            '',
            ['driver' => 'hyperdrive'],
        );

        $this->assertInstanceOf(PostgresGrammar::class, $connection->getQueryGrammar());
        $this->assertSame('pgsql', $connection->getPdo()->getAttribute(\PDO::ATTR_DRIVER_NAME));
    }
}
