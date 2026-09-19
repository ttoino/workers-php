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
    private array $errorInfo = ['', null, null];
    private array $attributes = [
        \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        \PDO::ATTR_CASE => \PDO::CASE_NATURAL,
    ];
    private bool $inTxn = false;

    public function __construct(string|D1HttpClient $endpoint)
    {
        // Parent gets an unused in-memory database to honour the
        // `extends \PDO` contract.
        parent::__construct('sqlite::memory:');
        $this->client = is_string($endpoint) ? new D1HttpClient($endpoint) : $endpoint;
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        return HttpD1PDOStatement::create($this, $query, $this->attributes);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): \PDOStatement|false
    {
        $stmt = $this->prepare($query);
        if ($stmt === false) return false;
        if ($fetchMode !== null && $stmt instanceof HttpD1PDOStatement) $stmt->setFetchMode($fetchMode);
        if ($stmt instanceof HttpD1PDOStatement) $stmt->execute();

        return $stmt;
    }

    public function exec(string $statement): int|false
    {
        try {
            return $this->client->exec($statement);
        } catch (\Throwable $e) {
            $this->errorInfo = ['HY000', null, $e->getMessage()];
            if ($this->attributes[\PDO::ATTR_ERRMODE] === \PDO::ERRMODE_EXCEPTION) throw $e;

            return false;
        }
    }

    public function lastInsertId(?string $name = null): string|false
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

    public function quote(string $string, int $type = \PDO::PARAM_STR): string|false
    {
        return "'" . str_replace("'", "''", $string) . "'";
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

    public function errorInfo(): array
    {
        return $this->errorInfo;
    }

    public function getClient(): D1HttpClient
    {
        return $this->client;
    }

    public function getAttributes(): array
    {
        return $this->attributes;
    }

    public function setErrorInfo(array $info): void
    {
        $this->errorInfo = $info;
    }
}
