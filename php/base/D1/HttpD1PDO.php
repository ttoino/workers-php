<?php

namespace WorkersPhp\D1;

/**
 * PDO-compatible drop-in backed by a D1 HTTP endpoint, so Laravel's
 * SQLite grammar works against D1 from any PHP runtime.
 *
 * Extends \PDO purely so `\PDO` type hints accept it; the parent
 * instance is never used — every method routes through the endpoint.
 */
final class HttpD1PDO extends \PDO
{
    private D1HttpClient $client;

    private int $lastInsertId = 0;

    /** @var array{0: string, 1: int|null, 2: string|null} */
    private array $errorInfo = ['', null, null];

    /** @var array<int, mixed> */
    private array $attributes = [
        \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        \PDO::ATTR_CASE => \PDO::CASE_NATURAL,
        // Laravel's Connection::getServerVersion() reads ATTR_SERVER_VERSION
        // with a string return type; D1 runs on SQLite 3.
        \PDO::ATTR_DRIVER_NAME => 'sqlite',
        \PDO::ATTR_SERVER_VERSION => '3.40.0',
    ];

    private bool $inTxn = false;

    public function __construct(string|D1HttpClient $endpoint)
    {
        // Parent gets an unused in-memory database to honour the
        // `extends \PDO` contract.
        parent::__construct('sqlite::memory:');
        $this->client = is_string($endpoint) ? new D1HttpClient($endpoint) : $endpoint;
    }

    /** @param array<int, mixed> $options */
    public function prepare(string $query, array $options = []): \PDOStatement
    {
        return HttpD1PDOStatement::create($this, $query, $this->attributes);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): \PDOStatement
    {
        $stmt = $this->prepare($query);
        if ($fetchMode !== null && $stmt instanceof HttpD1PDOStatement) {
            $stmt->setFetchMode($fetchMode);
        }
        if ($stmt instanceof HttpD1PDOStatement) {
            $stmt->execute();
        }

        return $stmt;
    }

    public function exec(string $statement): int|false
    {
        try {
            return $this->client->exec($statement);
        } catch (\Throwable $e) {
            $this->errorInfo = ['HY000', null, $e->getMessage()];
            if ($this->attributes[\PDO::ATTR_ERRMODE] === \PDO::ERRMODE_EXCEPTION) {
                throw $e;
            }

            return false;
        }
    }

    public function lastInsertId(?string $name = null): string
    {
        return (string) $this->lastInsertId;
    }

    public function setLastInsertId(int $id): void
    {
        $this->lastInsertId = $id;
    }

    public function beginTransaction(): bool
    {
        // D1 has no interactive transactions over HTTP; each statement is
        // applied atomically on its own.
        $this->inTxn = true;

        return true;
    }

    public function commit(): bool
    {
        $this->inTxn = false;

        return true;
    }

    public function rollBack(): bool
    {
        $this->inTxn = false;

        return true;
    }

    public function inTransaction(): bool
    {
        return $this->inTxn;
    }

    public function quote(string $string, int $type = \PDO::PARAM_STR): string
    {
        return "'".str_replace("'", "''", $string)."'";
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        $this->attributes[$attribute] = $value;

        return true;
    }

    public function getAttribute(int $attribute): mixed
    {
        return $this->attributes[$attribute] ?? null;
    }

    public function errorCode(): ?string
    {
        return $this->errorInfo[0] ?: null;
    }

    /** @return array{0: string, 1: int|null, 2: string|null} */
    public function errorInfo(): array
    {
        return $this->errorInfo;
    }

    public function getClient(): D1HttpClient
    {
        return $this->client;
    }

    /** @return array<int, mixed> */
    public function getAttributes(): array
    {
        return $this->attributes;
    }

    /** @param array{0: string, 1: int|null, 2: string|null} $info */
    public function setErrorInfo(array $info): void
    {
        $this->errorInfo = $info;
    }
}
