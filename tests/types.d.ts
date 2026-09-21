// Test-env bindings for the typed phpWorker path: declaration merging
// fills the global Env the library ships empty for consumers to
// augment via `wrangler types`.
import type { Container } from "@cloudflare/containers";

declare global {
    interface Env {
        API: Fetcher;
        CONTAINER: DurableObjectNamespace<Container>;
        DATA: R2Bucket;
        DB: D1Database;
        EMAIL: SendEmail;
        FILES: R2Bucket;
        HYPERDRIVE: Hyperdrive;
        KV: KVNamespace;
        QUEUE: Queue;
        WEATHER: AnalyticsEngineDataset;
    }
}

export {};
