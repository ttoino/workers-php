import { getContainer } from "@cloudflare/containers";
import type { Container } from "@cloudflare/containers";

export interface PhpWorkerOptions<C extends string, B extends string> {
    /** Deadline for holding requests while a cold container boots. */
    bootDeadlineMs?: number;
    /** Env key holding the Durable Object binding for the container. */
    container: C;
    /** Named Durable Object instance; a singleton suits a single PHP app. */
    name?: string;
    /** Serve objects from an R2 bucket under a URL prefix, no boot needed. */
    storage?: { bucket: B; prefix: string };
}

export type PhpWorkerEnv<C extends string, B extends string> = Record<C, DurableObjectNamespace<Container>> &
    Record<B, R2Bucket>;

export interface BootHoldOptions {
    deadlineMs?: number;
}

/**
 * A cold container answers 503 + Retry-After until its entrypoint finishes;
 * hold the request instead of surfacing an error page. The app owns the
 * pacing via Retry-After, the worker owns the deadline — a 503 without the
 * header is not the boot gate and passes through untouched.
 */
export const holdThroughBoot = async (
    fetchRequest: (request: Request) => Promise<Response>,
    request: Request,
    options: BootHoldOptions = {},
): Promise<Response> => {
    const deadline = Date.now() + (options.deadlineMs ?? 25_000);

    let response = await fetchRequest(request.clone());
    while (response.status === 503 && Date.now() < deadline) {
        const header = response.headers.get("retry-after");
        if (header === null) break;
        const retryAfter = Number(header);
        if (!Number.isFinite(retryAfter)) break;
        await new Promise((resolve) =>
            setTimeout(resolve, Math.min(Math.max(retryAfter * 1000, 500), 5_000)),
        );
        response = await fetchRequest(request.clone());
    }

    return response;
};

/** Stream an object from R2 for requests under `prefix`; null when the path does not match. */
export const serveR2 = async (
    request: Request,
    bucket: R2Bucket,
    prefix: string,
): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return null;
    if (request.method !== "GET" && request.method !== "HEAD") return null;

    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const headers = new Headers();

    if (request.method === "HEAD") {
        const object = await bucket.head(key);
        if (!object) return new Response("Not found", { status: 404 });
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=300");
        return new Response(null, { headers });
    }

    const object = await bucket.get(key, { onlyIf: request.headers });
    if (!object) return new Response("Not found", { status: 404 });
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=300");
    if (!("body" in object)) return new Response(null, { status: 304, headers });

    return new Response(object.body, { headers });
};

/**
 * Fetch handler for a single-container PHP app: R2 static serving, boot
 * hold, everything else proxied to the container.
 *
 *   export default phpWorker({ container: "CONTAINER", storage: { bucket: "FILES", prefix: "/storage/" } });
 */
export const phpWorker = <C extends string, B extends string = never>(
    options: PhpWorkerOptions<C, B>,
): ExportedHandler<PhpWorkerEnv<C, B>> => ({
        async fetch(request, env) {
            if (options.storage) {
                const bucket: R2Bucket | undefined = env[options.storage.bucket];
                if (!bucket) throw new Error(`workers-php: no binding named "${options.storage.bucket}"`);
                const served = await serveR2(request, bucket, options.storage.prefix);
                if (served) return served;
            }

            const namespace: DurableObjectNamespace<Container> | undefined = env[options.container];
            if (!namespace) throw new Error(`workers-php: no binding named "${options.container}"`);
            const container = getContainer(namespace, options.name ?? "default");

            return holdThroughBoot((req) => container.fetch(req), request, {
                deadlineMs: options.bootDeadlineMs,
            });
        },
    });
