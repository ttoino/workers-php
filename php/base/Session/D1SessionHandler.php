<?php

namespace WorkersPhp\Session;

use WorkersPhp\D1\D1HttpClient;
use WorkersPhp\D1\HttpD1PDO;

/**
 * PHP session storage on D1: the container's filesystem is ephemeral, so
 * file-backed sessions would log everyone out on every cold start.
 *
 * The storage table is created once per process on first use (CREATE TABLE
 * IF NOT EXISTS), so consumers only need to register the handler.
 */
class D1SessionHandler implements \SessionHandlerInterface
{
    /** @var array<string, bool> */
    private static array $ensured = [];

    private HttpD1PDO $pdo;

    public function __construct(
        string|D1HttpClient|HttpD1PDO $endpoint,
        private readonly string $table = 'sessions',
        bool $autoCreate = true,
    ) {
        $this->pdo = $endpoint instanceof HttpD1PDO ? $endpoint : new HttpD1PDO($endpoint);

        if ($autoCreate && ! isset(self::$ensured[$table])) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS "'.$table.'" (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)',
            );
            $this->pdo->exec('CREATE INDEX IF NOT EXISTS "'.$table.'_expires" ON "'.$table.'" (expires)');
            self::$ensured[$table] = true;
        }
    }

    public static function register(string|D1HttpClient|HttpD1PDO $endpoint, string $table = 'sessions'): self
    {
        $handler = new self($endpoint, $table);
        session_set_save_handler($handler, true);

        return $handler;
    }

    public function open(string $path, string $name): bool
    {
        return true;
    }

    public function close(): bool
    {
        return true;
    }

    public function read(string $id): string|false
    {
        $statement = $this->pdo->prepare('SELECT data FROM "'.$this->table.'" WHERE id = ? AND expires > ?');
        $statement->execute([$id, time()]);
        $row = $statement->fetch(\PDO::FETCH_ASSOC);

        return $row === false ? '' : $row['data'];
    }

    public function write(string $id, string $data): bool
    {
        $ttl = (int) ini_get('session.gc_maxlifetime') ?: 1440;

        $statement = $this->pdo->prepare(
            'INSERT INTO "'.$this->table.'" (id, data, expires) VALUES (?, ?, ?) '
            .'ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires = excluded.expires',
        );

        return $statement->execute([$id, $data, time() + $ttl]);
    }

    public function destroy(string $id): bool
    {
        $statement = $this->pdo->prepare('DELETE FROM "'.$this->table.'" WHERE id = ?');

        return $statement->execute([$id]);
    }

    public function gc(int $max_lifetime): int|false
    {
        $statement = $this->pdo->prepare('DELETE FROM "'.$this->table.'" WHERE expires <= ?');
        $statement->execute([time()]);

        return 0;
    }
}
