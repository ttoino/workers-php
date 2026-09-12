<?php
// workers-php — PHP-side runtime helpers. Mounted into the wasm FS at
// cold start and `require_once`d on every request.
//
// Defines \WorkersPHP\Env plus D1/R2/KV client classes and a PDO shim.
// Bindings reach user code through the `$env` global, which the prelude
// populates from createPhpHandler's `bindings` option.

namespace WorkersPHP;

if (!class_exists(__NAMESPACE__ . '\\Env')) {

    /**
     * Magic accessor giving PHP code an `$env`-style binding map mirroring
     * what a Workers JS handler sees in its `env` parameter.
     */
    final class Env {
        /** @var array<string, array{type: string, binding?: string, value?: mixed}> */
        private array $declarations;

        /** @var array<string, mixed> Cached binding instances. */
        private array $cache = [];

        /**
         * @param array<string, array{type: string, binding?: string, value?: mixed}> $declarations
         */
        public function __construct(array $declarations) {
            $this->declarations = $declarations;
        }

        public function __get(string $name): mixed {
            if (array_key_exists($name, $this->cache)) {
                return $this->cache[$name];
            }
            if (!isset($this->declarations[$name])) {
                throw new \RuntimeException(
                    "workers-php: unknown binding '$name'. Declare it in the createPhpHandler({ bindings }) option."
                );
            }
            $d = $this->declarations[$name];
            $value = match ($d['type']) {
                'd1'      => new D1Database($d['binding']),
                'r2'      => new R2Bucket($d['binding']),
                'kv'      => new KVNamespace($d['binding']),
                'var',
                'secret'  => $d['value'] ?? null,
                default   => throw new \RuntimeException("workers-php: binding '$name' has unknown type '{$d['type']}'"),
            };
            $this->cache[$name] = $value;
            return $value;
        }

        public function __isset(string $name): bool {
            return isset($this->declarations[$name]);
        }
    }

    /** Wraps a Workers D1 binding. Mirrors env.DB.* methods. */
    final class D1Database {
        public function __construct(public readonly string $binding) {}

        /** Begin a prepared statement. SQL may contain `?` positional or
         *  `:name` named placeholders; both are supported. */
        public function prepare(string $sql): D1PreparedStatement {
            return new D1PreparedStatement($this->binding, $sql);
        }

        /** Execute one or more raw SQL statements (no parameters). Mirrors
         *  D1's `exec()` — semi-colon-separated statements, all-or-nothing. */
        public function exec(string $sql): array {
            return \workers_php_call('d1_exec', [$this->binding, $sql]);
        }

        /** Run a list of prepared statements in a single atomic transaction.
         *  @param D1PreparedStatement[] $statements
         *  @return D1Result[] */
        public function batch(array $statements): array {
            $payload = [];
            foreach ($statements as $s) {
                if (!$s instanceof D1PreparedStatement) {
                    throw new \TypeError('D1Database::batch expects D1PreparedStatement[]');
                }
                $payload[] = ['sql' => $s->getRewrittenSql(), 'params' => $s->getBindings()];
            }
            $raw = \workers_php_call('d1_batch', [$this->binding, $payload]);
            $results = [];
            foreach ($raw as $r) {
                $results[] = D1Result::fromArray($r);
            }
            return $results;
        }
    }

    final class D1PreparedStatement {
        /** @var array<int|string, mixed> */
        private array $bindings = [];

        /** @var string SQL with `:name` placeholders rewritten to `?`. */
        private string $rewrittenSql;

        /** @var string[]|null Ordered list of placeholder names, or null
         *                     if SQL uses positional placeholders only. */
        private ?array $paramOrder;

        public function __construct(public readonly string $binding, public readonly string $sql) {
            [$this->rewrittenSql, $this->paramOrder] = self::rewriteNamedPlaceholders($sql);
        }

        public function getRewrittenSql(): string { return $this->rewrittenSql; }

        /** @return array<int, mixed> Positional values in execute() order. */
        public function getBindings(): array { return array_values($this->bindings); }

        public function bind(mixed ...$values): self {
            $clone = clone $this;
            // Positional: 1-indexed in PDO, 0-indexed internally here.
            $clone->bindings = array_values($values);
            return $clone;
        }

        /** PDO-style execute: pass an array of values (positional or named).
         *  Returns $this for chaining with first()/all()/run(). */
        public function execute(array $values = []): self {
            $clone = clone $this;
            if ($this->paramOrder !== null) {
                $ordered = [];
                foreach ($this->paramOrder as $name) {
                    $key = $name;
                    if (!array_key_exists($key, $values)) {
                        // PDO accepts both `:name` and `name` as keys.
                        $alt = ':' . $name;
                        if (array_key_exists($alt, $values)) $key = $alt;
                    }
                    $ordered[] = $values[$key] ?? null;
                }
                $clone->bindings = $ordered;
            } else {
                $clone->bindings = array_values($values);
            }
            return $clone;
        }

        public function all(): D1Result {
            $raw = \workers_php_call('d1_all', [$this->binding, $this->rewrittenSql, $this->getBindings()]);
            return D1Result::fromArray($raw);
        }

        public function first(?string $colName = null): mixed {
            return \workers_php_call('d1_first', [$this->binding, $this->rewrittenSql, $this->getBindings(), $colName]);
        }

        public function run(): D1Result {
            $raw = \workers_php_call('d1_run', [$this->binding, $this->rewrittenSql, $this->getBindings()]);
            return D1Result::fromArray($raw);
        }

        public function raw(): array {
            return \workers_php_call('d1_raw', [$this->binding, $this->rewrittenSql, $this->getBindings()]);
        }

        /**
         * Translate `:name` placeholders to `?` for D1's positional-only
         * binder; text inside single-quoted strings is left alone.
         *
         * @return array{0: string, 1: string[]|null}
         */
        private static function rewriteNamedPlaceholders(string $sql): array {
            $hasNamed = (bool) preg_match('/:[A-Za-z_][A-Za-z0-9_]*/', $sql);
            if (!$hasNamed) return [$sql, null];

            $order = [];
            $out = '';
            $i = 0;
            $len = strlen($sql);
            $inString = false;
            while ($i < $len) {
                $ch = $sql[$i];
                if ($inString) {
                    $out .= $ch;
                    if ($ch === "'" && ($i + 1 < $len) && $sql[$i + 1] === "'") {
                        // Escaped single quote in SQL: ''.
                        $out .= $sql[$i + 1];
                        $i += 2;
                        continue;
                    }
                    if ($ch === "'") $inString = false;
                    $i++;
                    continue;
                }
                if ($ch === "'") {
                    $inString = true;
                    $out .= $ch;
                    $i++;
                    continue;
                }
                if ($ch === ':' && $i + 1 < $len && (ctype_alpha($sql[$i + 1]) || $sql[$i + 1] === '_')) {
                    $j = $i + 1;
                    while ($j < $len && (ctype_alnum($sql[$j]) || $sql[$j] === '_')) $j++;
                    $name = substr($sql, $i + 1, $j - $i - 1);
                    $order[] = $name;
                    $out .= '?';
                    $i = $j;
                    continue;
                }
                $out .= $ch;
                $i++;
            }
            return [$out, $order];
        }
    }

    /** Mirrors Workers D1's return shape for .all() / .run(). */
    final class D1Result {
        /**
         * @param array<int, array<string, mixed>> $results
         * @param array{duration?: float, rows_read?: int, rows_written?: int, last_row_id?: int, changes?: int} $meta
         */
        public function __construct(
            public readonly array $results,
            public readonly bool $success,
            public readonly object $meta,
        ) {}

        public static function fromArray(array $raw): self {
            $meta = (object) (
                isset($raw['meta']) && is_array($raw['meta']) ? $raw['meta'] : []
            );
            return new self(
                $raw['results'] ?? [],
                (bool) ($raw['success'] ?? true),
                $meta,
            );
        }
    }

    /**
     * PDO-compatible drop-in backed by D1, so code hardcoding
     * `new PDO('sqlite:...')` works with a one-line swap.
     *
     * Extends \PDO purely so `\PDO` type hints accept it; the parent
     * instance is never used — every method routes through D1.
     */
    final class D1PDO extends \PDO {
        private D1Database $d1;
        private int $lastInsertId = 0;
        private array $errorInfo = ['', null, null];
        private array $attributes = [
            \PDO::ATTR_ERRMODE             => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE  => \PDO::FETCH_ASSOC,
            \PDO::ATTR_CASE                => \PDO::CASE_NATURAL,
        ];
        private bool $inTxn = false;

        public function __construct(string|D1Database $db) {
            // Parent gets an unused in-memory database to honour the
            // `extends \PDO` contract.
            parent::__construct('sqlite::memory:');
            $this->d1 = is_string($db) ? new D1Database($db) : $db;
        }

        public function prepare(string $query, array $options = []): \PDOStatement|false {
            return D1PDOStatement::create($this, new D1PreparedStatement($this->d1->binding, $query), $this->attributes);
        }

        public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): \PDOStatement|false {
            $stmt = $this->prepare($query);
            if ($stmt === false) return false;
            if ($fetchMode !== null && $stmt instanceof D1PDOStatement) $stmt->setFetchMode($fetchMode);
            if ($stmt instanceof D1PDOStatement) $stmt->execute();
            return $stmt;
        }

        public function exec(string $statement): int|false {
            try {
                $result = $this->d1->exec($statement);
                return (int) ($result['count'] ?? 0);
            } catch (\Throwable $e) {
                $this->errorInfo = ['HY000', null, $e->getMessage()];
                if ($this->attributes[\PDO::ATTR_ERRMODE] === \PDO::ERRMODE_EXCEPTION) throw $e;
                return false;
            }
        }

        public function lastInsertId(?string $name = null): string|false {
            return (string) $this->lastInsertId;
        }

        public function setLastInsertId(int $id): void {
            $this->lastInsertId = $id;
        }

        public function beginTransaction(): bool {
            // D1 has no interactive transactions via the binding API; use
            // D1Database::batch() for atomic writes.
            $this->inTxn = true;
            return true;
        }
        public function commit(): bool { $this->inTxn = false; return true; }
        public function rollBack(): bool { $this->inTxn = false; return true; }
        public function inTransaction(): bool { return $this->inTxn; }

        public function quote(string $string, int $type = \PDO::PARAM_STR): string|false {
            return "'" . str_replace("'", "''", $string) . "'";
        }

        public function setAttribute(int $attribute, mixed $value): bool {
            $this->attributes[$attribute] = $value;
            return true;
        }
        public function getAttribute(int $attribute): mixed {
            return $this->attributes[$attribute] ?? null;
        }

        public function errorCode(): ?string {
            return $this->errorInfo[0] ?: null;
        }
        public function errorInfo(): array {
            return $this->errorInfo;
        }

        /** Used by D1PDOStatement after run() to seed lastInsertId. */
        public function getD1(): D1Database { return $this->d1; }
        public function getAttributes(): array { return $this->attributes; }
        public function setErrorInfo(array $info): void { $this->errorInfo = $info; }
    }

    /**
     * PDOStatement-compatible shim. \PDOStatement's constructor is
     * private, so instances are built via
     * ReflectionClass::newInstanceWithoutConstructor() plus a factory.
     */
    final class D1PDOStatement extends \PDOStatement implements \IteratorAggregate {
        private ?D1Result $result = null;
        private int $cursor = 0;
        private int $fetchMode;
        private D1PDO $pdo;
        private D1PreparedStatement $stmt;
        /** @var array<int|string, mixed> */
        private array $pendingBindings = [];

        public static function create(D1PDO $pdo, D1PreparedStatement $stmt, array $attributes): self {
            $obj = (new \ReflectionClass(self::class))->newInstanceWithoutConstructor();
            $obj->pdo = $pdo;
            $obj->stmt = $stmt;
            $obj->fetchMode = $attributes[\PDO::ATTR_DEFAULT_FETCH_MODE] ?? \PDO::FETCH_ASSOC;
            return $obj;
        }

        public function execute(?array $params = null): bool {
            try {
                if ($params === null && $this->pendingBindings) {
                    $params = $this->pendingBindings;
                }
                $this->pendingBindings = [];
                if ($params !== null) {
                    $this->stmt = $this->stmt->execute($params);
                }
                $this->result = $this->stmt->run();
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

        public function bindValue(int|string $param, mixed $value, int $type = \PDO::PARAM_STR): bool {
            // Translate to positional/named binding via the underlying D1PreparedStatement.
            // Stash and fold into the next execute() call.
            $this->pendingBindings[$param] = $value;
            return true;
        }

        public function bindParam(int|string $param, mixed &$var, int $type = \PDO::PARAM_STR, int $maxLength = 0, mixed $driverOptions = null): bool {
            return $this->bindValue($param, $var, $type);
        }

        public function fetch(int $mode = \PDO::FETCH_DEFAULT, int $cursorOrientation = \PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed {
            if (!$this->result) return false;
            $row = $this->result->results[$this->cursor] ?? null;
            if ($row === null) return false;
            $this->cursor++;
            $effective = $mode && $mode !== \PDO::FETCH_DEFAULT ? $mode : $this->fetchMode;
            return $this->shapeRow($row, $effective);
        }

        public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, mixed ...$args): array {
            if (!$this->result) return [];
            $effective = $mode && $mode !== \PDO::FETCH_DEFAULT ? $mode : $this->fetchMode;
            return array_map(fn($r) => $this->shapeRow($r, $effective), array_slice($this->result->results, $this->cursor));
        }

        public function fetchColumn(int $column = 0): mixed {
            $row = $this->fetch(\PDO::FETCH_NUM);
            if ($row === false) return false;
            return $row[$column] ?? null;
        }

        public function fetchObject(?string $class = 'stdClass', array $constructorArgs = []): object|false {
            $row = $this->fetch(\PDO::FETCH_ASSOC);
            if ($row === false) return false;
            $class = $class ?? 'stdClass';
            if ($class === 'stdClass') return (object) $row;
            $obj = new $class(...$constructorArgs);
            foreach ($row as $k => $v) $obj->$k = $v;
            return $obj;
        }

        public function rowCount(): int {
            return $this->result?->meta->changes
                ?? (is_array($this->result?->results) ? count($this->result->results) : 0);
        }

        public function columnCount(): int {
            $first = $this->result?->results[0] ?? null;
            return is_array($first) ? count($first) : 0;
        }

        public function closeCursor(): bool {
            $this->cursor = $this->result ? count($this->result->results) : 0;
            return true;
        }

        public function setFetchMode(int $mode, mixed ...$args): true {
            $this->fetchMode = $mode;
            return true;
        }

        public function getIterator(): \Generator {
            while (($row = $this->fetch()) !== false) yield $row;
        }

        private function shapeRow(array $row, int $mode): mixed {
            switch ($mode) {
                case \PDO::FETCH_ASSOC: return $row;
                case \PDO::FETCH_NUM:   return array_values($row);
                case \PDO::FETCH_BOTH:  return array_merge($row, array_values($row));
                case \PDO::FETCH_OBJ:   return (object) $row;
                default:                return $row;
            }
        }
    }

    /** Wraps a Workers R2 bucket binding. */
    final class R2Bucket {
        public function __construct(public readonly string $binding) {}

        public function get(string $key): ?R2ObjectBody {
            $raw = \workers_php_call('r2_get', [$this->binding, $key]);
            if ($raw === null) return null;
            return R2ObjectBody::fromArray($raw);
        }

        public function head(string $key): ?R2Object {
            $raw = \workers_php_call('r2_head', [$this->binding, $key]);
            if ($raw === null) return null;
            return R2Object::fromArray($raw);
        }

        /**
         * @param string $body Raw bytes (binary-safe).
         * @param array{contentType?: string, customMetadata?: array<string, string>} $opts
         */
        public function put(string $key, string $body, array $opts = []): R2Object {
            $raw = \workers_php_call('r2_put', [
                $this->binding,
                $key,
                base64_encode($body),
                $opts,
            ]);
            return R2Object::fromArray($raw);
        }

        public function delete(string|array $keys): void {
            \workers_php_call('r2_delete', [$this->binding, $keys]);
        }

        /**
         * @param array{prefix?: string, limit?: int, cursor?: string, delimiter?: string} $opts
         * @return array{objects: R2Object[], truncated: bool, cursor?: string}
         */
        public function list(array $opts = []): array {
            $raw = \workers_php_call('r2_list', [$this->binding, $opts]);
            return [
                'objects'   => array_map(fn($o) => R2Object::fromArray($o), $raw['objects'] ?? []),
                'truncated' => (bool) ($raw['truncated'] ?? false),
                'cursor'    => $raw['cursor'] ?? null,
            ];
        }
    }

    /** R2 object metadata. */
    class R2Object {
        public function __construct(
            public readonly string $key,
            public readonly int $size,
            public readonly string $etag,
            public readonly string $httpEtag,
            public readonly ?string $uploaded,
            public readonly ?string $contentType,
            public readonly array $customMetadata,
        ) {}

        public static function fromArray(array $raw): static {
            return new static(
                (string) ($raw['key'] ?? ''),
                (int)    ($raw['size'] ?? 0),
                (string) ($raw['etag'] ?? ''),
                (string) ($raw['httpEtag'] ?? ''),
                $raw['uploaded'] ?? null,
                $raw['contentType'] ?? null,
                $raw['customMetadata'] ?? [],
            );
        }
    }

    /** R2 object + body. Body is decoded from base64 on the JS side. */
    final class R2ObjectBody extends R2Object {
        public function __construct(
            string $key, int $size, string $etag, string $httpEtag,
            ?string $uploaded, ?string $contentType, array $customMetadata,
            private readonly string $bodyB64,
        ) {
            parent::__construct($key, $size, $etag, $httpEtag, $uploaded, $contentType, $customMetadata);
        }

        public static function fromArray(array $raw): static {
            return new static(
                (string) ($raw['key'] ?? ''),
                (int)    ($raw['size'] ?? 0),
                (string) ($raw['etag'] ?? ''),
                (string) ($raw['httpEtag'] ?? ''),
                $raw['uploaded'] ?? null,
                $raw['contentType'] ?? null,
                $raw['customMetadata'] ?? [],
                (string) ($raw['bodyB64'] ?? ''),
            );
        }

        public function body(): string {
            return base64_decode($this->bodyB64, true) ?: '';
        }

        /** Alias matching Workers JS R2Object.arrayBuffer(). */
        public function arrayBuffer(): string { return $this->body(); }
        public function text(): string { return $this->body(); }
        public function json(): mixed { return json_decode($this->body(), true); }
    }

    /** Wraps a Workers KV namespace binding. */
    final class KVNamespace {
        public function __construct(public readonly string $binding) {}

        public function get(string $key, string $type = 'text'): mixed {
            $raw = \workers_php_call('kv_get', [$this->binding, $key, $type]);
            return $raw;
        }

        /**
         * @param array{expiration?: int, expirationTtl?: int, metadata?: array} $opts
         */
        public function put(string $key, string $value, array $opts = []): void {
            \workers_php_call('kv_put', [$this->binding, $key, $value, $opts]);
        }

        public function delete(string $key): void {
            \workers_php_call('kv_delete', [$this->binding, $key]);
        }

        /**
         * @param array{prefix?: string, limit?: int, cursor?: string} $opts
         * @return array{keys: array<int, array{name: string, expiration?: int, metadata?: mixed}>, list_complete: bool, cursor?: string}
         */
        public function list(array $opts = []): array {
            return \workers_php_call('kv_list', [$this->binding, $opts]);
        }
    }

    /**
     * D1-backed session save handler. The table is created on first use
     * via the JS-side d1_ensure_sessions_table dispatch (cached per
     * isolate); use `setupSchema: false` to pre-create it explicitly.
     *
     * Layout: workers_php_sessions(id TEXT PRIMARY KEY, data BLOB NOT
     * NULL, expires INTEGER NOT NULL).
     *
     * createPhpHandler's `sessionHandler` option registers this via
     * session_set_save_handler() before any session_start().
     */
    class SessionHandlerD1 implements \SessionHandlerInterface, \SessionUpdateTimestampHandlerInterface {
        public function __construct(
            private D1Database $db,
            private string $table = 'workers_php_sessions',
            private int $ttlSeconds = 86400,
        ) {}

        public function open(string $path, string $name): bool { return true; }
        public function close(): bool { return true; }

        public function read(string $id): string {
            try {
                $row = $this->db->prepare(
                    "SELECT data FROM \"{$this->table}\" WHERE id = ? AND expires > ?"
                )->bind($id, time())->first();
                if (!is_array($row)) return '';
                return (string) ($row['data'] ?? '');
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerD1::read failed: " . $e->getMessage());
                return '';
            }
        }

        public function write(string $id, string $data): bool {
            
            try {
                $this->db->prepare(
                    "INSERT INTO \"{$this->table}\"(id, data, expires) VALUES(?, ?, ?) " .
                    "ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires = excluded.expires"
                )->bind($id, $data, time() + $this->ttlSeconds)->run();
                return true;
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerD1::write failed: " . $e->getMessage());
                return false;
            }
        }

        public function destroy(string $id): bool {
            try {
                $this->db->prepare(
                    "DELETE FROM \"{$this->table}\" WHERE id = ?"
                )->bind($id)->run();
                return true;
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerD1::destroy failed: " . $e->getMessage());
                return false;
            }
        }

        public function gc(int $maxLifetime): int|false {
            try {
                $this->db->prepare(
                    "DELETE FROM \"{$this->table}\" WHERE expires < ?"
                )->bind(time())->run();
                return 0;
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerD1::gc failed: " . $e->getMessage());
                return false;
            }
        }

        public function validateId(string $id): bool {
            try {
                $row = $this->db->prepare(
                    "SELECT 1 AS x FROM \"{$this->table}\" WHERE id = ? AND expires > ?"
                )->bind($id, time())->first();
                return is_array($row);
            } catch (\Throwable $e) {
                return false;
            }
        }

        public function updateTimestamp(string $id, string $data): bool {
            return $this->write($id, $data);
        }
    }

    /**
     * KV-backed session save handler, keyed by `<prefix><session-id>`.
     * Per-key TTL makes gc() a no-op.
     *
     * Caveats for busy sessions: KV is eventually consistent (~60s) and
     * allows ~1 write/sec per key.
     */
    class SessionHandlerKV implements \SessionHandlerInterface, \SessionUpdateTimestampHandlerInterface {
        public function __construct(
            private KVNamespace $kv,
            private string $prefix = 'sess:',
            private int $ttlSeconds = 86400,
        ) {}

        public function open(string $path, string $name): bool { return true; }
        public function close(): bool { return true; }

        public function read(string $id): string {
            try {
                $value = $this->kv->get($this->prefix . $id);
                return $value === null ? '' : (string) $value;
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerKV::read failed: " . $e->getMessage());
                return '';
            }
        }

        public function write(string $id, string $data): bool {
            try {
                $this->kv->put(
                    $this->prefix . $id,
                    $data,
                    ['expirationTtl' => $this->ttlSeconds],
                );
                return true;
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerKV::write failed: " . $e->getMessage());
                return false;
            }
        }

        public function destroy(string $id): bool {
            try {
                $this->kv->delete($this->prefix . $id);
                return true;
            } catch (\Throwable $e) {
                \error_log("workers-php SessionHandlerKV::destroy failed: " . $e->getMessage());
                return false;
            }
        }

        public function gc(int $maxLifetime): int|false { return 0; }

        public function validateId(string $id): bool {
            try {
                return $this->kv->get($this->prefix . $id) !== null;
            } catch (\Throwable $e) {
                return false;
            }
        }

        public function updateTimestamp(string $id, string $data): bool {
            return $this->write($id, $data);
        }
    }
}
