import { env as workerEnv } from "cloudflare:workers";
import { d1, log, mail, PhpContainer, phpOutbound, r2 } from "workers-php";

export class AppContainer extends PhpContainer {
    // Injected into the container at boot; secrets come from worker secrets.
    envVars = {
        APP_ENV: "production",
        APP_KEY: workerEnv.APP_KEY,
        APP_URL: "http://localhost:8787",
        CACHE_STORE: "database",
        DB_CONNECTION: "d1",
        DB_D1_ENDPOINT: "http://d1.app",
        FILESYSTEM_DISK: "r2",
        LOG_CHANNEL: "stderr",
        MAIL_ENDPOINT: "http://email.app",
        MAIL_FROM_ADDRESS: "noreply@example.com",
        MAIL_FROM_NAME: "Example",
        MAIL_MAILER: "http-mail",
        QUEUE_CONNECTION: "sync",
        R2_ENDPOINT: "http://files.app",
        SESSION_DRIVER: "cookie",
    };
    pingEndpoint = "/ping.php";

    sleepAfter = "10m";
}

// Magic hosts for the container's egress: plain HTTP on the same machine,
// resolved against this worker's bindings. Hosts derive from the binding
// names and must be publicly resolvable — the derived host for "DB"
// (db.app) does not resolve, so it is overridden to one that does.
AppContainer.outboundByHost = phpOutbound(
    d1("DB", { host: "d1.app" }),
    r2("FILES"),
    mail("EMAIL"),
    log(),
);
