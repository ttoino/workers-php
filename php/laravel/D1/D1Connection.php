<?php

namespace WorkersPhp\Laravel\D1;

use Illuminate\Database\SQLiteConnection;

// Laravel 13 on PHP >= 8.4 drives SQLite transactions with literal
// BEGIN/SAVEPOINT SQL over exec(), bypassing PDO::beginTransaction; D1
// rejects transaction SQL outright. Route the statements back to the
// driver's documented no-op transaction semantics.
final class D1Connection extends SQLiteConnection
{
    protected function executeBeginTransactionStatement()
    {
        $this->getPdo()->beginTransaction();
    }

    protected function createSavepoint() {}

    protected function performRollBack($toLevel)
    {
        if ($toLevel === 0) {
            $this->getPdo()->rollBack();
        }
    }
}
