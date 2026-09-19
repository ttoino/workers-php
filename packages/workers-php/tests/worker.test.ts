import { describe, expect, it, vi } from "vitest";

import { holdThroughBoot, phpWorker, serveR2 } from "../src/worker";

const booting = () =>
    new Response("booting", { headers: { "Retry-After": "1" }, status: 503 });

describe("holdThroughBoot", () => {
    it("retries through the boot window and lands on the real response", async () => {
        const responses = [booting(), booting(), new Response("ok")];
        const fetchRequest = vi.fn().mockImplementation(async () => responses.shift()!);

        const response = await holdThroughBoot(fetchRequest, new Request("http://x.dev/"));

        expect(fetchRequest).toHaveBeenCalledTimes(3);
        expect(await response.text()).toBe("ok");
    });

    it("passes a 503 without Retry-After straight through", async () => {
        const plain = new Response("nope", { status: 503 });
        const fetchRequest = vi.fn().mockResolvedValue(plain);

        const response = await holdThroughBoot(fetchRequest, new Request("http://x.dev/"));

        expect(fetchRequest).toHaveBeenCalledTimes(1);
        expect(response).toBe(plain);
    });

    it("gives up after the deadline and returns the last response", async () => {
        const fetchRequest = vi.fn().mockImplementation(async () => booting());

        const response = await holdThroughBoot(fetchRequest, new Request("http://x.dev/"), {
            deadlineMs: 50,
        });

        expect(response.status).toBe(503);
        expect(fetchRequest.mock.calls.length).toBeLessThan(4);
    });

    it("clones the request so POST bodies survive every attempt", async () => {
        const bodies: string[] = [];
        const fetchRequest = vi.fn().mockImplementation(async (request: Request) => {
            bodies.push(await request.text());
            return bodies.length < 2 ? booting() : new Response("ok");
        });

        await holdThroughBoot(fetchRequest, new Request("http://x.dev/", { body: "payload", method: "POST" }));

        expect(bodies).toEqual(["payload", "payload"]);
    });
});

describe("serveR2", () => {
    const bucket = {
        get: vi.fn(),
        head: vi.fn(),
    };
    const object = {
        body: "content",
        httpEtag: '"tag"',
        writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/webp"),
    };

    it("ignores paths outside the prefix", async () => {
        expect(await serveR2(new Request("http://x.dev/app.css"), bucket as never, "/storage/")).toBeNull();
    });

    it("ignores non-GET methods under the prefix", async () => {
        expect(
            await serveR2(new Request("http://x.dev/storage/a", { method: "POST" }), bucket as never, "/storage/"),
        ).toBeNull();
    });

    it("streams objects with cache headers", async () => {
        bucket.get.mockResolvedValueOnce(object);
        const response = await serveR2(new Request("http://x.dev/storage/users/1.webp"), bucket as never, "/storage/");

        expect(bucket.get).toHaveBeenCalledWith("users/1.webp", { onlyIf: expect.any(Headers) });
        expect(response?.headers.get("Cache-Control")).toBe("public, max-age=300");
        expect(response?.headers.get("etag")).toBe('"tag"');
        expect(await response?.text()).toBe("content");
    });

    it("answers 304 when the condition fails", async () => {
        bucket.get.mockResolvedValueOnce({ httpEtag: '"tag"', writeHttpMetadata: object.writeHttpMetadata });
        const response = await serveR2(
            new Request("http://x.dev/storage/a", { headers: { "If-None-Match": '"tag"' } }),
            bucket as never,
            "/storage/",
        );

        expect(response?.status).toBe(304);
    });

    it("404s missing keys", async () => {
        bucket.get.mockResolvedValueOnce(null);
        const response = await serveR2(new Request("http://x.dev/storage/missing"), bucket as never, "/storage/");

        expect(response?.status).toBe(404);
    });
});

describe("phpWorker", () => {
    const worker = () =>
        phpWorker({ container: "CONTAINER", name: "app", storage: { bucket: "FILES", prefix: "/storage/" } });

    const namespace = (fetch: (request: Request) => Promise<Response>) =>
        ({
            get: vi.fn().mockReturnValue({ fetch }),
            idFromName: vi.fn().mockReturnValue("id"),
        }) as never;

    it("serves /storage from the bucket without touching the container", async () => {
        const containerFetch = vi.fn();
        const env = {
            CONTAINER: namespace(containerFetch),
            FILES: {
                get: vi.fn().mockResolvedValue({
                    body: "img",
                    httpEtag: '"e"',
                    writeHttpMetadata: () => {},
                }),
            },
        };

        const response = await worker().fetch!(new Request("http://x.dev/storage/a.webp"), env as never, {} as never);

        expect(containerFetch).not.toHaveBeenCalled();
        expect(await response.text()).toBe("img");
    });

    it("proxies everything else to the container", async () => {
        const containerFetch = vi.fn().mockResolvedValue(new Response("from php"));
        const env = { CONTAINER: namespace(containerFetch), FILES: { get: vi.fn() } };

        const response = await worker().fetch!(new Request("http://x.dev/login"), env as never, {} as never);

        expect(containerFetch).toHaveBeenCalled();
        expect(await response.text()).toBe("from php");
    });

    it("throws a clear error for a missing binding", async () => {
        await expect(
            worker().fetch!(new Request("http://x.dev/storage/a"), { CONTAINER: namespace(vi.fn()) } as never, {} as never),
        ).rejects.toThrow('workers-php: no binding named "FILES"');
    });
});
