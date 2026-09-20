<?php

namespace WorkersPhp\Laravel\Cache;

use Illuminate\Contracts\Cache\Store;
use WorkersPhp\KV\KVHttpClient;

/**
 * Cache store on a KV namespace endpoint. TTLs ride KV's native
 * expiration; flush() sweeps the store's prefix through list + delete
 * (KV has no atomic clear, so it is best effort).
 */
class KVStore implements Store
{
    public function __construct(
        private readonly KVHttpClient $client,
        private readonly string $prefix = '',
    ) {}

    public function get($key)
    {
        return $this->client->getValue($this->prefix.$key);
    }

    /**
     * @param  array<int, string>  $keys
     * @return array<string, mixed>
     */
    public function many(array $keys)
    {
        $values = [];
        foreach ($keys as $key) {
            $values[$key] = $this->get($key);
        }

        return $values;
    }

    public function put($key, $value, $seconds)
    {
        $this->client->put($this->prefix.$key, $value, $seconds > 0 ? $seconds : null);

        return true;
    }

    /** @param array<string, mixed> $values */
    public function putMany(array $values, $seconds)
    {
        foreach ($values as $key => $value) {
            $this->put($key, $value, $seconds);
        }

        return true;
    }

    public function touch($key, $seconds)
    {
        $value = $this->get($key);
        if ($value === null) {
            return false;
        }

        return $this->put($key, $value, $seconds);
    }

    public function increment($key, $value = 1)
    {
        return $this->adjust($key, $value);
    }

    public function decrement($key, $value = 1)
    {
        return $this->adjust($key, -$value);
    }

    public function forever($key, $value)
    {
        $this->client->put($this->prefix.$key, $value);

        return true;
    }

    public function forget($key)
    {
        $this->client->delete($this->prefix.$key);

        return true;
    }

    public function flush()
    {
        $cursor = null;
        do {
            $page = $this->client->list($this->prefix, 1000, $cursor);
            foreach ($page['keys'] as $entry) {
                $this->client->delete($entry['name']);
            }
            $cursor = $page['list_complete'] ? null : $page['cursor'];
        } while ($cursor !== null);

        return true;
    }

    public function getPrefix()
    {
        return $this->prefix;
    }

    /** KV has no atomic increment; rewrite the value keeping the TTL. */
    private function adjust(string $key, int $delta): int|false
    {
        $current = $this->get($key);
        if ($current === null || ! is_numeric($current)) {
            return false;
        }

        $next = (int) $current + $delta;
        $this->client->put($this->prefix.$key, (string) $next, $this->remainingTtl($key));

        return $next;
    }

    /** Remaining seconds to live, or null when the key never expires. */
    private function remainingTtl(string $key): ?int
    {
        $full = $this->prefix.$key;
        foreach ($this->client->list($full, 100)['keys'] as $entry) {
            if ($entry['name'] === $full) {
                return $entry['expiration'] !== null
                    ? max(1, $entry['expiration'] - time())
                    : null;
            }
        }

        return null;
    }
}
