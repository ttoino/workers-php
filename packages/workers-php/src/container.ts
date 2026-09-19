import type { OutboundHandler } from "@cloudflare/containers";

import { Container } from "@cloudflare/containers";
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

export interface Outbound<E = Cloudflare.Env> {
    handle: OutboundHandler<E>;
    host: string;
}

export interface OutboundOptions {
    host?: string;
}

const defaultHost = (binding: string) => `${binding.toLowerCase()}.app`;

const binding = <T, K extends string>(env: Record<K, T>, name: K): T => {
    const value = env[name];
    if (value === undefined)
        throw new Error(`workers-php: no binding named "${name}"`);
    return value;
};

/**
 * Speaks the D1 query protocol the PHP runtime expects:
 *
 *   POST {host}/query  {"sql": "...", "params": [...]}  → D1 result JSON
 *   POST {host}/exec   {"sql": "..."}                   → {"count": n}
 */
export const d1 = <K extends string>(
    name: K,
    options: OutboundOptions = {},
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
    host: options.host ?? defaultHost(name),
});

/**
 * REST-ish object protocol the PHP R2 client expects: GET/HEAD/PUT/DELETE
 * on /{key}, plus GET /?list&prefix&limit&cursor for pagination. DELETE
 * with a JSON body deletes a batch of keys.
 */
export const r2 = <K extends string>(
    name: K,
    options: OutboundOptions = {},
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
    host: options.host ?? defaultHost(name),
});

/**
 * Structured mail protocol: POST {host}/send with
 * {from, to[], subject, html?, text?}. Cloudflare's send_email binding
 * takes one recipient per EmailMessage, so one message is built per
 * address.
 */
export const mail = <K extends string>(
    name: K,
    options: OutboundOptions = {},
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
    host: options.host ?? defaultHost(name),
});

/** Debug sink: the container's boot output lands in the worker's tail. */
export const log = (options: OutboundOptions = {}): Outbound => ({
    handle: async (request) => {
        console.log("container boot:", await request.text());
        return new Response("ok");
    },
    host: options.host ?? "log.app",
});

/**
 * Compose outbound factories into a Container's `outboundByHost` map:
 *
 *   static outboundByHost = phpOutbound(d1("DB"), r2("FILES"), mail("EMAIL"));
 *
 * Hosts default to the lowercased binding name plus `.app`.
 */
export const phpOutbound = (
    ...outbounds: Outbound[]
): Record<string, OutboundHandler> =>
    Object.fromEntries(
        outbounds.map((outbound) => [outbound.host, outbound.handle]),
    );

export class PhpContainer<E = Cloudflare.Env> extends Container<E> {
    defaultPort = 8080;

    override onError(error: unknown): void {
        console.log(`container error: ${error}`);
    }

    override onStop(stop: { exitCode: number; reason: string }): void {
        console.log(
            `container stopped: code=${stop.exitCode} reason=${stop.reason}`,
        );
    }
}
