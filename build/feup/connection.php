<?php
// workers-php overlay: replace upstream's getDBConnection() so it returns
// a Cloudflare-D1-backed PDO instance instead of new PDO('sqlite:main.db').
//
// The rest of the project (Model::getDB, executeQuery, etc.) is unchanged
// because \WorkersPHP\D1PDO extends \PDO — type hints accept it as-is.

    function getDBConnection(string $db_name = '', string $schema = "sqlite") : PDO {
        // The upstream signature took a path argument; we ignore it. The
        // binding to use comes from the request's `$env->DB`.
        try {
            static $pdo = null;
            if ($pdo !== null) return $pdo;

            global $env;
            if (!isset($env) || !isset($env->DB)) {
                throw new RuntimeException(
                    "workers-php: \$env->DB binding is missing. Make sure your createPhpHandler() options declare bindings: { DB: 'd1' }."
                );
            }

            $pdo = new \WorkersPHP\D1PDO($env->DB);
            $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            // D1 enables foreign keys by default; PRAGMA exec() would be a
            // no-op via D1Database::exec() but we skip it to avoid a wasted
            // bridge round-trip.

            return $pdo;
        } catch (PDOException $exception) {
            die("Error connecting to DB: ".$exception->getMessage());
        }
    }

    function getQueryResults(PDO $db, string $query, bool $fetchMultiple = true, array $params = null) : array | false {
        try {
            list($result, $stmt) = executeQuery($db, $query, $params);

            if ($result)
                return $fetchMultiple ? $stmt->fetchAll() : $stmt->fetch();
        } catch (PDOException $e) {
        } // do nothing and leave block, expected behavior is to return false

        return false;
    }

    function executeQuery(PDO $db, string $query, array $params = null): array {
        try {
            if ($stmt = $db->prepare($query))
                return array($stmt->execute($params), $stmt);
        } catch (PDOException $e) {
        } // do nothing and leave block, expected behavior is to return false

        return array(false, null);
    }
?>
