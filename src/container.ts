import { EmailMessage } from "cloudflare:email";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createMimeMessage } from "mimetext";

import type { KeyOf } from "./env";

export interface Outbound<E = Cloudflare.Env> {
    handle: OutboundHandler<E>;
    path: string;
}

export type OutboundHandler<E = Cloudflare.Env> = {
    handle(
        request: Request,
        env: E,
        ctx: ExecutionContext,
    ): Promise<Response> | Response;
}["handle"];

export const binding = <T, K extends string>(env: Record<K, T>, name: K): T => {
    const value = env[name];
    if (value === undefined)
        throw new Error(`workers-php: no binding named "${name}"`);
    return value;
};

/**
 * Speaks the D1 query protocol the PHP runtime expects, relative to the
 * outbound path (the endpoint is `{host}/{name}`):
 *
 *   POST {endpoint}/query  {"sql": "...", "params": [...]}  → D1 result JSON
 *   POST {endpoint}/exec   {"sql": "..."}                   → {"count": n}
 */
export const d1 = <K extends KeyOf<D1Database>>(
    name: K,
): Outbound<Record<K, D1Database>> => ({
    handle: async (request, env) => {
        try {
            const db = binding(env, name);
            const url = new URL(request.url);
            const body = (await request.json()) as {
                params?: unknown[];
                sql: string;
            };
            if (url.pathname === "/exec") {
                return Response.json(await db.exec(body.sql));
            }
            const statement = db.prepare(body.sql);
            return Response.json(
                await (
                    body.params?.length
                        ? statement.bind(...body.params)
                        : statement
                ).all(),
            );
        } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
        }
    },
    path: `/${name}`,
});

/**
 * REST-ish object protocol the PHP R2 client expects: GET/HEAD/PUT/DELETE
 * on {endpoint}/{key}, plus GET {endpoint}/?list&prefix&limit&cursor for
 * pagination. DELETE with a JSON body deletes a batch of keys.
 */
export const r2 = <K extends KeyOf<R2Bucket>>(
    name: K,
): Outbound<Record<K, R2Bucket>> => ({
    handle: async (request, env) => {
        const bucket = binding(env, name);
        const url = new URL(request.url);

        if (url.searchParams.has("list")) {
            const page = await bucket.list({
                cursor: url.searchParams.get("cursor") ?? undefined,
                limit: Number(url.searchParams.get("limit") ?? 1000),
                prefix: url.searchParams.get("prefix") ?? undefined,
            });
            return Response.json({
                cursor: page.truncated ? page.cursor : null,
                objects: page.objects.map((object) => ({
                    key: object.key,
                    size: object.size,
                })),
                truncated: page.truncated,
            });
        }

        const key = decodeURIComponent(url.pathname.slice(1));
        const headers = new Headers();
        switch (request.method) {
            case "DELETE": {
                const batch = (await request.json().catch(() => null)) as {
                    keys?: string[];
                } | null;
                await bucket.delete(batch?.keys ?? key);
                return new Response("ok");
            }
            case "GET": {
                const object = await bucket.get(key);
                if (!object) return new Response("Not found", { status: 404 });
                object.writeHttpMetadata(headers);
                return new Response(object.body, { headers });
            }
            case "HEAD": {
                const object = await bucket.head(key);
                if (!object) return new Response("Not found", { status: 404 });
                object.writeHttpMetadata(headers);
                headers.set("Content-Length", String(object.size));
                headers.set("Last-Modified", object.uploaded.toUTCString());
                return new Response(null, { headers });
            }
            case "PUT":
                await bucket.put(key, request.body, {
                    httpMetadata: {
                        contentType:
                            request.headers.get("Content-Type") ?? undefined,
                    },
                });
                return new Response("ok");
            default:
                return new Response("Method not allowed", { status: 405 });
        }
    },
    path: `/${name}`,
});

/**
 * Queue producer protocol: POST {endpoint}/send with
 * {body, contentType?, delaySeconds?} → send(); POST
 * {endpoint}/sendBatch with {messages: [...]} → sendBatch(). Producing
 * only — consuming happens through the worker's queue() handler.
 */
export const queue = <K extends KeyOf<Queue>>(
    name: K,
): Outbound<Record<K, Queue<unknown>>> => ({
    handle: async (request, env) => {
        try {
            const target = binding(env, name);
            const url = new URL(request.url);
            const body = (await request.json()) as {
                body?: string;
                contentType?: "json" | "text";
                delaySeconds?: number;
                messages?: {
                    body: string;
                    contentType?: "json" | "text";
                    delaySeconds?: number;
                }[];
            };
            if (url.pathname === "/send") {
                await target.send(body.body ?? "", {
                    contentType: body.contentType ?? "text",
                    delaySeconds: body.delaySeconds,
                });
                return new Response("ok");
            }
            if (url.pathname === "/sendBatch") {
                await target.sendBatch(
                    (body.messages ?? []).map((message) => ({
                        body: message.body,
                        contentType: message.contentType ?? "text",
                        delaySeconds: message.delaySeconds,
                    })),
                );
                return new Response("ok");
            }
            return new Response("Not found", { status: 404 });
        } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
        }
    },
    path: `/${name}`,
});

/**
 * Analytics Engine protocol: POST {endpoint}/write with
 * {index?, blobs?, doubles?} → writeDataPoint. One index per call, up to
 * 20 blobs (16 KB total) and 20 doubles; fire-and-forget.
 */
export const analytics = <K extends KeyOf<AnalyticsEngineDataset>>(
    name: K,
): Outbound<Record<K, AnalyticsEngineDataset>> => ({
    handle: async (request, env) => {
        const dataset = binding(env, name);
        const url = new URL(request.url);
        if (url.pathname !== "/write" || request.method !== "POST")
            return new Response("Not found", { status: 404 });
        const body = (await request.json()) as {
            blobs?: string[];
            doubles?: number[];
            index?: string;
        };
        dataset.writeDataPoint({
            blobs: body.blobs ?? [],
            doubles: body.doubles ?? [],
            indexes: body.index ? [body.index] : [],
        });
        return new Response("ok");
    },
    path: `/${name}`,
});

/**
 * Proxy any request to a service binding: {endpoint}/* is forwarded as
 * received (method, path, query, headers, body) and the response comes
 * back verbatim. No PHP client needed — any HTTP stack works:
 *
 *   Http::get(env("API_ENDPOINT")."/users");
 */
export const service = <K extends KeyOf<Fetcher>>(
    name: K,
): Outbound<Record<K, Fetcher>> => ({
    handle: (request, env) => {
        const target = binding(env, name);
        const url = new URL(request.url);
        return target.fetch(
            new Request(`http://service${url.pathname}${url.search}`, request),
        );
    },
    path: `/${name}`,
});

/**
 * REST-ish key-value protocol the PHP KV client expects: GET/PUT/DELETE
 * on {endpoint}/{key}, plus GET {endpoint}/?list&prefix&limit&cursor.
 * Metadata and TTL ride the X-KV-Metadata and X-KV-Expiration-Ttl
 * headers.
 */
export const kv = <K extends KeyOf<KVNamespace>>(
    name: K,
): Outbound<Record<K, KVNamespace>> => ({
    handle: async (request, env) => {
        const store = binding(env, name);
        const url = new URL(request.url);

        if (url.searchParams.has("list")) {
            const page = await store.list({
                cursor: url.searchParams.get("cursor") ?? undefined,
                limit: Number(url.searchParams.get("limit") ?? 1000),
                prefix: url.searchParams.get("prefix") ?? undefined,
            });
            return Response.json({
                cursor: page.list_complete ? null : page.cursor,
                keys: page.keys.map((key) => ({
                    expiration: key.expiration ?? null,
                    metadata: key.metadata ?? null,
                    name: key.name,
                })),
                list_complete: page.list_complete,
            });
        }

        const key = decodeURIComponent(url.pathname.slice(1));
        switch (request.method) {
            case "DELETE":
                await store.delete(key);
                return new Response("ok");
            case "GET": {
                const { metadata, value } = await store.getWithMetadata(key);
                if (value === null)
                    return new Response("Not found", { status: 404 });
                const headers = new Headers();
                if (metadata !== null)
                    headers.set("X-KV-Metadata", JSON.stringify(metadata));
                return new Response(value, { headers });
            }
            case "PUT": {
                const metadataHeader = request.headers.get("X-KV-Metadata");
                const ttl = request.headers.get("X-KV-Expiration-Ttl");
                await store.put(key, await request.text(), {
                    expirationTtl: ttl ? Number(ttl) : undefined,
                    metadata: metadataHeader
                        ? JSON.parse(metadataHeader)
                        : undefined,
                });
                return new Response("ok");
            }
            default:
                return new Response("Method not allowed", { status: 405 });
        }
    },
    path: `/${name}`,
});

/**
 * Structured mail protocol: POST {endpoint}/send with
 * {from, to[], subject, html?, text?}. Cloudflare's send_email binding
 * takes one recipient per EmailMessage, so one message is built per
 * address.
 */
export const mail = <K extends KeyOf<SendEmail>>(
    name: K,
): Outbound<Record<K, SendEmail>> => ({
    handle: async (request, env) => {
        try {
            const email = binding(env, name);
            const { from, html, subject, text, to } =
                (await request.json()) as {
                    from: string;
                    html?: string;
                    subject: string;
                    text?: string;
                    to: string[];
                };
            for (const address of to) {
                const message = createMimeMessage();
                message.setSender({ addr: from });
                message.setRecipient({ addr: address });
                message.setSubject(subject ?? "");
                if (text)
                    message.addMessage({
                        contentType: "text/plain",
                        data: text,
                    });
                if (html)
                    message.addMessage({
                        contentType: "text/html",
                        data: html,
                    });
                await email.send(
                    new EmailMessage(from, address, message.asRaw()),
                );
            }
            return new Response("sent");
        } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
        }
    },
    path: `/${name}`,
});

/**
 * Debug sink: the container's boot output lands in the worker's tail.
 * With `sink`, the same body is also POSTed to a real endpoint (best
 * effort, from the worker side so it never re-enters interception).
 */
export const log = (options: { sink?: string } = {}): Outbound => ({
    handle: async (request) => {
        const body = await request.text();
        console.log("container boot:", body);
        if (options.sink) {
            try {
                await fetch(options.sink, { body, method: "POST" });
            } catch {
                // Best effort: a dead sink must not fail the container.
            }
        }
        return new Response("ok");
    },
    path: "/log",
});

/**
 * Compose outbound factories into a Container's `outboundByHost` map:
 *
 *   static outboundByHost = phpOutbound(d1("DB"), r2("FILES"), mail("EMAIL"));
 *
 * All traffic goes through a single shared host (default `example.com`,
 * IANA-reserved and always resolvable): interception keys on the host
 * alone and diverts before egress, so the host never receives real
 * traffic and only its DNS record matters. Each factory routes under a
 * path derived from its binding name, verbatim — `d1("DB")` answers
 * `http://example.com/DB/*`.
 */
export const phpOutbound = (
    configOrOutbound: { host?: string } | Outbound,
    ...outbounds: Outbound[]
): Record<string, OutboundHandler> => {
    const isOutbound = (value: unknown): value is Outbound =>
        typeof value === "object" && value !== null && "handle" in value;
    const host = isOutbound(configOrOutbound)
        ? "example.com"
        : (configOrOutbound.host ?? "example.com");
    const routes = [
        ...(isOutbound(configOrOutbound) ? [configOrOutbound] : []),
        ...outbounds,
    ].sort((a, b) => b.path.length - a.path.length);
    const paths = routes.map((route) => route.path);
    const duplicate = paths.find(
        (path, index) => paths.indexOf(path) !== index,
    );
    if (duplicate !== undefined)
        throw new Error(`workers-php: duplicate outbound path "${duplicate}"`);
    return {
        [host]: (request, env, ctx) => {
            const url = new URL(request.url);
            for (const { handle, path } of routes) {
                if (
                    url.pathname === path ||
                    url.pathname.startsWith(`${path}/`)
                ) {
                    const stripped = new URL(request.url);
                    stripped.pathname = url.pathname.slice(path.length) || "/";
                    return handle(new Request(stripped, request), env, ctx);
                }
            }
            return Response.json(
                { error: `workers-php: no outbound route for ${url.pathname}` },
                { status: 404 },
            );
        },
    };
};

/** Header carrying the target port on internal worker-to-container calls. */
export const phpContainerPortHeader = "x-workers-php-port";

interface PhpOutboundProps {
    className: string;
    host: string;
}

const outboundRegistry = new Map<string, Record<string, OutboundHandler>>();

interface PhpOutboundExports {
    PhpOutbound: PhpOutboundFactory;
}

type PhpOutboundFactory = (options: { props: PhpOutboundProps }) => Fetcher;

/**
 * Loopback entrypoint receiving the container's intercepted outbound
 * traffic; dispatches to the handler the container class registered with
 * `outboundByHost`. Export it from the worker entrypoint so the container
 * can bind it (`export { PhpOutbound } from "workers-php"`).
 */
export class PhpOutbound extends WorkerEntrypoint<
    Cloudflare.Env,
    PhpOutboundProps
> {
    async fetch(request: Request): Promise<Response> {
        const { className, host } = this.ctx.props;
        const handler = outboundRegistry.get(className)?.[host];
        if (!handler)
            return Response.json(
                {
                    error: `workers-php: no outbound handler for host "${host}"`,
                },
                { status: 500 },
            );
        return handler(request, this.env, this.ctx);
    }
}

// A Durable Object cannot return a subfetch's WebSocket response verbatim:
// bridge the container socket to a fresh pair and forward frames both ways.
const bridgeWebSocket = (containerWs: WebSocket): Response => {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    containerWs.accept();
    server.accept();
    server.addEventListener("message", async (event) => {
        try {
            const data =
                event.data instanceof Blob
                    ? await event.data.arrayBuffer()
                    : event.data;
            containerWs.send(data);
        } catch {
            server.close(1011, "Failed to forward message to container");
        }
    });
    containerWs.addEventListener("message", async (event) => {
        try {
            const data =
                event.data instanceof Blob
                    ? await event.data.arrayBuffer()
                    : event.data;
            server.send(data);
        } catch {
            containerWs.close(1011, "Failed to forward message to client");
        }
    });
    const closeCode = (code: number) =>
        code === 1005 || code === 1006 ? 1000 : code;
    server.addEventListener("close", (event) =>
        containerWs.close(closeCode(event.code), event.reason),
    );
    containerWs.addEventListener("close", (event) =>
        server.close(closeCode(event.code), event.reason),
    );
    return new Response(null, { status: 101, webSocket: client });
};

const hasPhpOutbound = (exports: unknown): exports is PhpOutboundExports =>
    typeof exports === "object" &&
    exports !== null &&
    "PhpOutbound" in exports &&
    typeof exports.PhpOutbound === "function";

/**
 * PHP application container on the native Durable Object container API:
 * the image and instance size are chosen at start (the `durable_object`
 * scheduling policy), traffic is proxied to `defaultPort`, and outbound
 * interception routes through the class's `outboundByHost` map. Readiness
 * is owned by the PHP runtime's boot gate (503 + Retry-After), which
 * phpWorker holds against.
 */
export class PhpContainer<E = Cloudflare.Env> extends DurableObject<E> {
    static get outboundByHost(): Record<string, OutboundHandler> | undefined {
        return outboundRegistry.get(this.name);
    }
    static set outboundByHost(
        handlers: Record<string, OutboundHandler> | undefined,
    ) {
        if (handlers === undefined) outboundRegistry.delete(this.name);
        else outboundRegistry.set(this.name, handlers);
    }
    /** Container port web traffic proxies to. */
    defaultPort = 8080;
    /** Whether the container may reach the public internet. */
    enableInternet = true;
    /** Entrypoint override, e.g. to run a different artisan command. */
    entrypoint?: string[];
    /** Environment passed to the container at start; undefined values drop. */
    envVars: Record<string, string | undefined> = {};
    /** Key into the container's configured `images` map. */
    image = "app";

    /** How long the container outlives an inactive Durable Object. */
    inactivityTimeoutMs = 600_000;

    /** Instance size passed to `start()`. */
    instance: ContainerStartupOptions["instance"] = "lite";

    constructor(ctx: DurableObjectState, env: E) {
        super(ctx, env);
        const container = ctx.container;
        if (container?.running) {
            ctx.blockConcurrencyWhile(async () => {
                await this.registerIntercepts(container);
                await container.setInactivityTimeout(this.inactivityTimeoutMs);
            });
            this.monitor(container);
        }
    }

    async fetch(request: Request): Promise<Response> {
        const container = await this.ensureRunning();
        const internal = request.headers.get(phpContainerPortHeader);
        const port = internal === null ? this.defaultPort : Number(internal);
        // Container fetchers only accept plain HTTP. The original request
        // rides as init so WebSocket upgrades keep their client socket.
        const url = request.url.replace(/^https:/, "http:");
        try {
            const response = await container
                .getTcpPort(port)
                .fetch(url, request);
            if (!response.webSocket) return response;
            return bridgeWebSocket(response.webSocket);
        } catch (error) {
            // start() returns before the entrypoint listens; answer the boot
            // gate's own 503 so phpWorker holds the request through boot.
            if (
                error instanceof Error &&
                error.message.includes("not listening")
            )
                return new Response("container booting", {
                    headers: { "Retry-After": "1" },
                    status: 503,
                });
            throw error;
        }
    }

    private async ensureRunning(): Promise<Container> {
        const container = this.ctx.container;
        if (!container)
            throw new Error(
                "workers-php: no container configured for this Durable Object",
            );
        if (container.running) return container;

        await this.registerIntercepts(container);

        const image = container.images[this.image];
        if (image === undefined)
            throw new Error(
                `workers-php: no image named "${this.image}" in the container's images map`,
            );
        container.start({
            enableInternet: this.enableInternet,
            entrypoint: this.entrypoint,
            env: Object.fromEntries(
                Object.entries(this.envVars).filter(
                    (entry): entry is [string, string] =>
                        entry[1] !== undefined,
                ),
            ),
            image,
            instance: this.instance,
        });
        await container.setInactivityTimeout(this.inactivityTimeoutMs);
        this.monitor(container);
        return container;
    }

    private monitor(container: Container): void {
        this.ctx.waitUntil(
            container
                .monitor()
                .then(() => console.log("container stopped: code=0"))
                .catch((error: unknown) => {
                    const exitCode = (error as { exitCode?: unknown }).exitCode;
                    if (typeof exitCode === "number") {
                        console.log(
                            `container stopped: code=${exitCode} reason=${error instanceof Error ? error.message : String(error)}`,
                        );
                    } else {
                        console.log(`container error: ${String(error)}`);
                    }
                }),
        );
    }

    // Intercepts last until the container stops: register them on a fresh
    // start and whenever the Durable Object restarts over a live container.
    private async registerIntercepts(container: Container): Promise<void> {
        const handlers = outboundRegistry.get(this.constructor.name) ?? {};
        for (const host of Object.keys(handlers)) {
            if (!hasPhpOutbound(this.ctx.exports))
                throw new Error(
                    'workers-php: export PhpOutbound from "workers-php" in your worker entrypoint',
                );
            await container.interceptOutboundHttp(
                host,
                this.ctx.exports.PhpOutbound({
                    props: { className: this.constructor.name, host },
                }),
            );
        }
    }
}
