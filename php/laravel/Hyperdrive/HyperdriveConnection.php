<?php

namespace WorkersPhp\Laravel\Hyperdrive;

use Illuminate\Database\PostgresConnection;

// Postgres transactions already route through the PDO driver (unlike
// SQLite's literal SQL), which the HTTP PDO answers with its documented
// no-op semantics; savepoints pass through to the real database. No
// shims needed.
final class HyperdriveConnection extends PostgresConnection {}
