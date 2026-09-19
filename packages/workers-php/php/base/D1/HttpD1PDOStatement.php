<?php

namespace WorkersPhp\D1;

/**
 * PDOStatement-compatible shim. \PDOStatement's constructor is
 * private, so instances are built via
 * ReflectionClass::newInstanceWithoutConstructor() plus a factory.
 */
final class HttpD1PDOStatement extends \PDOStatement implements \IteratorAggregate
{
    private ?D1Result $result = null;
    private int $cursor = 0;
    private int $fetchMode;
    private HttpD1PDO $pdo;
    private string $sql;

    /** @var array<int|string, mixed> */
    private array $pendingBindings = [];

    public static function create(HttpD1PDO $pdo, string $sql, array $attributes): self
    {
        $obj = (new \ReflectionClass(self::class))->newInstanceWithoutConstructor();
        $obj->pdo = $pdo;
        $obj->sql = $sql;
        $obj->fetchMode = $attributes[\PDO::ATTR_DEFAULT_FETCH_MODE] ?? \PDO::FETCH_ASSOC;

        return $obj;
    }

    public function execute(?array $params = null): bool
    {
        try {
            if ($params === null && $this->pendingBindings) {
                $params = $this->pendingBindings;
            }
            $this->pendingBindings = [];

            $this->result = $this->pdo->getClient()->query($this->sql, $params ?? []);
            $this->cursor = 0;
            if (isset($this->result->meta->last_row_id) && $this->result->meta->last_row_id) {
                $this->pdo->setLastInsertId((int) $this->result->meta->last_row_id);
            }

            return $this->result->success;
        } catch (\Throwable $e) {
            $this->pdo->setErrorInfo(['HY000', null, $e->getMessage()]);
            if ($this->pdo->getAttribute(\PDO::ATTR_ERRMODE) === \PDO::ERRMODE_EXCEPTION) throw $e;

            return false;
        }
    }

    public function bindValue(int|string $param, mixed $value, int $type = \PDO::PARAM_STR): bool
    {
        // Stash and fold into the next execute() call.
        $this->pendingBindings[$param] = $value;

        return true;
    }

    public function bindParam(int|string $param, mixed &$var, int $type = \PDO::PARAM_STR, int $maxLength = 0, mixed $driverOptions = null): bool
    {
        return $this->bindValue($param, $var, $type);
    }

    public function fetch(int $mode = \PDO::FETCH_DEFAULT, int $cursorOrientation = \PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
        if (!$this->result) return false;
        $row = $this->result->results[$this->cursor] ?? null;
        if ($row === null) return false;
        $this->cursor++;
        $effective = $mode && $mode !== \PDO::FETCH_DEFAULT ? $mode : $this->fetchMode;

        return $this->shapeRow($row, $effective);
    }

    public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        if (!$this->result) return [];
        $effective = $mode && $mode !== \PDO::FETCH_DEFAULT ? $mode : $this->fetchMode;

        return array_map(fn ($r) => $this->shapeRow($r, $effective), array_slice($this->result->results, $this->cursor));
    }

    public function fetchColumn(int $column = 0): mixed
    {
        $row = $this->fetch(\PDO::FETCH_NUM);
        if ($row === false) return false;

        return $row[$column] ?? null;
    }

    public function fetchObject(?string $class = 'stdClass', array $constructorArgs = []): object|false
    {
        $row = $this->fetch(\PDO::FETCH_ASSOC);
        if ($row === false) return false;
        $class = $class ?? 'stdClass';
        if ($class === 'stdClass') return (object) $row;
        $obj = new $class(...$constructorArgs);
        foreach ($row as $k => $v) $obj->$k = $v;

        return $obj;
    }

    public function rowCount(): int
    {
        return $this->result?->meta->changes
            ?? (is_array($this->result?->results) ? count($this->result->results) : 0);
    }

    public function columnCount(): int
    {
        $first = $this->result?->results[0] ?? null;

        return is_array($first) ? count($first) : 0;
    }

    public function closeCursor(): bool
    {
        $this->cursor = $this->result ? count($this->result->results) : 0;

        return true;
    }

    public function setFetchMode(int $mode, mixed ...$args): true
    {
        $this->fetchMode = $mode;

        return true;
    }

    public function getIterator(): \Generator
    {
        while (($row = $this->fetch()) !== false) yield $row;
    }

    private function shapeRow(array $row, int $mode): mixed
    {
        switch ($mode) {
            case \PDO::FETCH_ASSOC: return $row;
            case \PDO::FETCH_NUM:   return array_values($row);
            case \PDO::FETCH_BOTH:  return array_merge($row, array_values($row));
            case \PDO::FETCH_OBJ:   return (object) $row;
            default:                return $row;
        }
    }
}
