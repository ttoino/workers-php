<?php

namespace WorkersPhp\D1;

use WorkersPhp\Http\CurlTransport;

/**
 * HTTP client for a D1 query endpoint. The endpoint (a Worker with the
 * D1 binding, or anything else implementing the protocol) accepts:
 *
 *   POST {endpoint}/query  {"sql": "...", "params": [...]}  → D1 result JSON
 *   POST {endpoint}/exec   {"sql": "..."}                   → {"count": n}
 */
final class D1HttpClient
{
    /** @var callable */
    private $transport;

    public function __construct(public readonly string $endpoint, ?callable $transport = null)
    {
        $this->transport = $transport ?? new CurlTransport();
    }

    /** Run a single statement, PDO-style (positional or named values). */
    public function query(string $sql, array $values = []): D1Result
    {
        [$rewritten, $order] = self::rewriteNamedPlaceholders($sql);

        if ($order !== null) {
            $ordered = [];
            foreach ($order as $name) {
                $key = $name;
                if (!array_key_exists($key, $values)) {
                    // PDO accepts both `:name` and `name` as keys.
                    $alt = ':' . $name;
                    if (array_key_exists($alt, $values)) $key = $alt;
                }
                $ordered[] = $values[$key] ?? null;
            }
            $values = $ordered;
        } else {
            $values = array_values($values);
        }

        return D1Result::fromArray($this->post('/query', ['sql' => $rewritten, 'params' => $values]));
    }

    /** Run one or more raw statements (migrations); returns rows written. */
    public function exec(string $sql): int
    {
        $raw = $this->post('/exec', ['sql' => $sql]);

        return (int) ($raw['count'] ?? 0);
    }

    private function post(string $path, array $body): array
    {
        [$code, , $raw] = ($this->transport)(
            'POST',
            $this->endpoint . $path,
            ['Content-Type: application/json'],
            json_encode($body),
        );

        if ($code >= 400) {
            throw new \RuntimeException("D1 endpoint error (HTTP $code): " . substr($raw, 0, 500));
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException("D1 endpoint returned invalid JSON (HTTP $code)");
        }
        if (isset($decoded['error'])) {
            throw new \RuntimeException('D1 endpoint error: ' . $decoded['error']);
        }

        return $decoded;
    }

    /**
     * Translate `:name` placeholders to `?` for positional-only binders;
     * text inside single-quoted strings is left alone.
     *
     * @return array{0: string, 1: string[]|null}
     */
    private static function rewriteNamedPlaceholders(string $sql): array
    {
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
                $order[] = substr($sql, $i + 1, $j - $i - 1);
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
