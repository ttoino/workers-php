<?php

namespace WorkersPhp\D1;

/** Mirrors the D1 return shape for .all() / .run(). */
final class D1Result
{
    /**
     * @param array<int, array<string, mixed>> $results
     */
    public function __construct(
        public readonly array $results,
        public readonly bool $success,
        public readonly object $meta,
    ) {}

    public static function fromArray(array $raw): self
    {
        $meta = (object) (isset($raw['meta']) && is_array($raw['meta']) ? $raw['meta'] : []);

        return new self(
            $raw['results'] ?? [],
            (bool) ($raw['success'] ?? true),
            $meta,
        );
    }
}
