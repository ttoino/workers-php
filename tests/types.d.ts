// Test-env bindings for the typed phpWorker path: declaration merging
// fills the global Env the library ships empty for consumers to
// augment via `wrangler types`.
import type { PhpContainer } from "../src/container";

declare global {
    interface Env {
        API: Fetcher;
        CONTAINER: DurableObjectNamespace<PhpContainer>;
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
