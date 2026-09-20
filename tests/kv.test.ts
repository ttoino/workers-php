import { describe, expect, it } from "vitest";

import { kv } from "../src/container";

interface Entry {
    expiration?: number;
    metadata?: unknown;
    value: string;
}

const stubStore = () => {
    const store = new Map<string, Entry>();
    return {
        delete: async (key: string) => {
            store.delete(key);
        },
        getWithMetadata: async (key: string) => {
            const entry = store.get(key);
            return {
                metadata: entry?.metadata ?? null,
                value: entry?.value ?? null,
            };
        },
        list: async (options: { prefix?: string }) => ({
            cursor: "",
            keys: [...store.entries()]
                .filter(([name]) => name.startsWith(options.prefix ?? ""))
                .map(([name, entry]) => ({
                    expiration: entry.expiration,
                    metadata: entry.metadata,
                    name,
                })),
            list_complete: true,
        }),
        put: async (
            key: string,
            value: string,
            options: { expirationTtl?: number; metadata?: unknown } = {},
        ) => {
            store.set(key, { metadata: options.metadata, value });
        },
        store,
    };
};

describe("kv", () => {
    it("round-trips a value with metadata", async () => {
        const store = stubStore();
        const env = { KV: store } as never;

        const put = await kv("KV").handle(
            new Request("http://example.com/greeting", {
                body: "hello",
                headers: { "X-KV-Metadata": JSON.stringify({ tag: "a" }) },
                method: "PUT",
            }),
            env,
            {} as never,
        );
        expect(put.status).toBe(200);
        expect(store.store.get("greeting")?.value).toBe("hello");

        const get = await kv("KV").handle(
            new Request("http://example.com/greeting"),
            env,
            {} as never,
        );
        expect(get.status).toBe(200);
        expect(await get.text()).toBe("hello");
        expect(get.headers.get("X-KV-Metadata")).toBe('{"tag":"a"}');
    });

    it("passes the TTL to the binding", async () => {
        const store = stubStore();
        let ttl: number | undefined;
        store.put = async (
            key: string,
            value: string,
            options: { expirationTtl?: number } = {},
        ) => {
            ttl = options.expirationTtl;
            store.store.set(key, { value });
        };

        await kv("KV").handle(
            new Request("http://example.com/k", {
                body: "v",
                headers: { "X-KV-Expiration-Ttl": "120" },
                method: "PUT",
            }),
            { KV: store } as never,
            {} as never,
        );

        expect(ttl).toBe(120);
    });

    it("404s on a missing key and deletes keys", async () => {
        const store = stubStore();
        store.store.set("k", { value: "v" });
        const env = { KV: store } as never;

        const missing = await kv("KV").handle(
            new Request("http://example.com/nope"),
            env,
            {} as never,
        );
        expect(missing.status).toBe(404);

        const deleted = await kv("KV").handle(
            new Request("http://example.com/k", { method: "DELETE" }),
            env,
            {} as never,
        );
        expect(deleted.status).toBe(200);
        expect(store.store.has("k")).toBe(false);
    });

    it("lists keys with a prefix filter", async () => {
        const store = stubStore();
        store.store.set("app/a", { value: "1" });
        store.store.set("app/b", { value: "2" });
        store.store.set("other/c", { value: "3" });

        const response = await kv("KV").handle(
            new Request("http://example.com/?list&prefix=app/"),
            { KV: store } as never,
            {} as never,
        );
        const body = (await response.json()) as {
            keys: { name: string }[];
            list_complete: boolean;
        };

        expect(response.status).toBe(200);
        expect(body.keys.map((key) => key.name)).toEqual(["app/a", "app/b"]);
        expect(body.list_complete).toBe(true);
    });
});
