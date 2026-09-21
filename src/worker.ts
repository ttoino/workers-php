import type { Container } from "@cloudflare/containers";

import type { ContainerKey, KeyOf } from "./env";

export interface BootHoldOptions {
    deadlineMs?: number;
}

/**
 * @deprecated phpWorker now types over the app's generated `Env`
 * directly; this alias remains for existing imports only.
 */
export type PhpWorkerEnv<C extends string, B extends string> = Record<
    B,
    R2Bucket
> &
    Record<C, DurableObjectNamespace<Container>>;

export interface PhpWorkerOptions<
    S extends ContainerKey = ContainerKey,
    R extends R2Key = never,
> {
    /** Deadline for holding requests while a cold container boots. */
    bootDeadlineMs?: number;
    /** Add a queue() handler that forwards batches to the container's consume endpoint. */
    consume?: boolean;
    /** Port the consume endpoint listens on inside the container. Default 8081. */
    consumePort?: number;
    /** Env key holding the Durable Object binding for the container. */
    container: S;
    /** Named Durable Object instance; a singleton suits a single PHP app. */
    name?: string;
    /** Add a scheduled() handler that forwards Cron Triggers to the container's schedule endpoint. */
    schedule?: boolean;
    /** Deadline for holding a cron event while a cold container boots. Default 120000. */
    scheduleDeadlineMs?: number;
    /** Serve objects from an R2 bucket under a URL prefix, no boot needed. */
    storage?: { bucket: R; prefix: string };
}

/**
 * The RPC brand makes DurableObjectNamespace flavors mutually invariant,
 * so phpWorker types the container binding through these minimal
 * structural interfaces instead: every container flavor satisfies them
 * (the RPC-projected stub methods are bivariantly compatible), without
 * the deep instantiation a flavor-typed constraint triggers.
 */
interface ContainerNamespace {
    get(id: DurableObjectId): ContainerStub;
    idFromName(name: string): DurableObjectId;
}

interface ContainerStub {
    containerFetch(request: Request, port?: number): Promise<Response>;
    fetch(request: Request): Promise<Response>;
}

type R2Key = KeyOf<R2Bucket>;

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
            setTimeout(
                resolve,
                Math.min(Math.max(retryAfter * 1000, 500), 5_000),
            ),
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
): Promise<null | Response> => {
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
    if (!("body" in object))
        return new Response(null, { headers, status: 304 });

    return new Response(object.body, { headers });
};

/**
 * Handler for a single-container PHP app: R2 static serving, boot hold,
 * everything else proxied to the container. With `consume: true` the
 * export also handles Cloudflare Queue batches: each message is POSTed
 * to the container's consume port (internal only, never routed) as
 * {id, attempts, body}; a 200 acks, anything else retries — honoring
 * the X-Queue-Delay response header as delaySeconds. With `schedule: true`
 * the export also handles Cron Triggers: each event POSTs /schedule on
 * the same internal port, holding through the boot window for up to
 * `scheduleDeadlineMs`; a non-200 response throws so the event shows as
 * failed in logs.
 *
 *   export default phpWorker({ container: "CONTAINER", storage: { bucket: "FILES", prefix: "/storage/" }, consume: true });
 */
export const phpWorker = <
    S extends ContainerKey,
    R extends R2Key = never,
    E extends Cloudflare.Env &
        Record<R, R2Bucket> &
        Record<S, ContainerNamespace> = Env,
>(
    options: PhpWorkerOptions<S, R>,
): ExportedHandler<E> => {
    const container = (env: E) => {
        const namespace = env[options.container];
        if (!namespace)
            throw new Error(
                `workers-php: no binding named "${options.container}"`,
            );
        return namespace.get(namespace.idFromName(options.name ?? "default"));
    };

    return {
        async fetch(request, env) {
            if (options.storage) {
                const bucket = env[options.storage.bucket];
                if (!bucket)
                    throw new Error(
                        `workers-php: no binding named "${options.storage.bucket}"`,
                    );
                const served = await serveR2(
                    request,
                    bucket,
                    options.storage.prefix,
                );
                if (served) return served;
            }

            return holdThroughBoot(
                (req) => container(env).fetch(req),
                request,
                {
                    deadlineMs: options.bootDeadlineMs,
                },
            );
        },

        ...(options.consume
            ? {
                  async queue(
                      batch: MessageBatch<unknown>,
                      env: E,
                  ): Promise<void> {
                      const port = options.consumePort ?? 8081;
                      for (const message of batch.messages) {
                          try {
                              const response = await container(
                                  env,
                              ).containerFetch(
                                  new Request("http://container/consume", {
                                      body: JSON.stringify({
                                          attempts: message.attempts,
                                          body: message.body,
                                          id: message.id,
                                      }),
                                      headers: {
                                          "Content-Type": "application/json",
                                      },
                                      method: "POST",
                                  }),
                                  port,
                              );
                              if (response.status === 200) {
                                  message.ack();
                              } else {
                                  const delay = Number(
                                      response.headers.get("X-Queue-Delay") ??
                                          0,
                                  );
                                  message.retry(
                                      Number.isFinite(delay) && delay > 0
                                          ? { delaySeconds: delay }
                                          : undefined,
                                  );
                              }
                          } catch {
                              message.retry();
                          }
                      }
                  },
              }
            : {}),

        ...(options.schedule
            ? {
                  async scheduled(
                      _controller: ScheduledController,
                      env: E,
                  ): Promise<void> {
                      const port = options.consumePort ?? 8081;
                      const response = await holdThroughBoot(
                          (request) =>
                              container(env).containerFetch(request, port),
                          new Request("http://container/schedule", {
                              method: "POST",
                          }),
                          {
                              deadlineMs: options.scheduleDeadlineMs ?? 120_000,
                          },
                      );
                      if (response.status !== 200)
                          throw new Error(
                              `workers-php: schedule run failed with status ${response.status}`,
                          );
                  },
              }
            : {}),
    };
};
