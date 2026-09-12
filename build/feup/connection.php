<?php
// workers-php overlay: getDBConnection() returns a D1-backed PDO instead
// of new PDO('sqlite:main.db').
//
// The rest of the project is unchanged: \WorkersPHP\D1PDO extends \PDO,
// so existing type hints accept it.

    function getDBConnection(string $db_name = '', string $schema = "sqlite") : PDO {
        // Upstream's path argument is ignored; the binding is $env->DB.
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
            // D1 enables foreign keys by default; the usual PRAGMA would
            // only waste a bridge round-trip.

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
        } // fall through to false

        return false;
    }

    function executeQuery(PDO $db, string $query, array $params = null): array {
        try {
            if ($stmt = $db->prepare($query))
                return array($stmt->execute($params), $stmt);
        } catch (PDOException $e) {
        } // fall through to the error tuple

        return array(false, null);
    }
?>
