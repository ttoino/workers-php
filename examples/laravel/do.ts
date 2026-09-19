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
        DB_D1_ENDPOINT: "http://example.com/DB",
        FILESYSTEM_DISK: "r2",
        LOG_CHANNEL: "stderr",
        MAIL_ENDPOINT: "http://example.com/EMAIL",
        MAIL_FROM_ADDRESS: "noreply@example.com",
        MAIL_FROM_NAME: "Example",
        MAIL_MAILER: "http-mail",
        QUEUE_CONNECTION: "sync",
        R2_ENDPOINT: "http://example.com/FILES",
        SESSION_DRIVER: "cookie",
    };
    pingEndpoint = "/ping.php";

    sleepAfter = "10m";
}

// One shared host for the container's egress: interception keys on the
// host alone and diverts to this worker's bindings before egress, so
// example.com (IANA-reserved, always resolvable) never sees real traffic.
// Each binding answers under a path named after it — d1("DB") serves
// http://example.com/DB/*, matching the *ENDPOINT* env vars above.
AppContainer.outboundByHost = phpOutbound(
    d1("DB"),
    r2("FILES"),
    mail("EMAIL"),
    log(),
);
