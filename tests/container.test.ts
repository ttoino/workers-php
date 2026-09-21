import type { OutboundHandler } from "@cloudflare/containers";

import { describe, expect, it, vi } from "vitest";

import { d1, log, mail, phpOutbound, r2 } from "../src/container";

const jsonRequest = (url: string, body: unknown, method = "POST") =>
    new Request(url, { body: JSON.stringify(body), method });

describe("d1", () => {
    it("forwards queries with bound params", async () => {
        const all = vi
            .fn()
            .mockResolvedValue({ meta: {}, results: [], success: true });
        const bind = vi.fn().mockReturnValue({ all });
        const prepare = vi.fn().mockReturnValue({ all, bind });
        const handler = d1("DB").handle;

        const response = await handler(
            jsonRequest("http://example.com/query", {
                params: [1, "x"],
                sql: "SELECT ?",
            }),
            { DB: { prepare } } as never,
            {} as never,
        );

        expect(prepare).toHaveBeenCalledWith("SELECT ?");
        expect(bind).toHaveBeenCalledWith(1, "x");
        expect(all).toHaveBeenCalled();
        expect(response.status).toBe(200);
    });

    it("skips bind when no params are given", async () => {
        const all = vi.fn().mockResolvedValue({ results: [] });
        const bind = vi.fn();
        const prepare = vi.fn().mockReturnValue({ all, bind });

        await d1("DB").handle(
            jsonRequest("http://example.com/query", { sql: "SELECT 1" }),
            {
                DB: { prepare },
            } as never,
            {} as never,
        );

        expect(bind).not.toHaveBeenCalled();
        expect(all).toHaveBeenCalled();
    });

    it("routes /exec to exec and returns the count", async () => {
        const exec = vi.fn().mockResolvedValue({ count: 3 });
        const response = await d1("DB").handle(
            jsonRequest("http://example.com/exec", {
                sql: "CREATE TABLE t (id int)",
            }),
            { DB: { exec } } as never,
            {} as never,
        );

        expect(exec).toHaveBeenCalledWith("CREATE TABLE t (id int)");
        expect(await response.json()).toEqual({ count: 3 });
    });

    it("answers 500 with the error message when the binding fails", async () => {
        const prepare = vi.fn().mockImplementation(() => {
            throw new Error("no such table");
        });
        const response = await d1("DB").handle(
            jsonRequest("http://example.com/query", { sql: "SELECT 1" }),
            {
                DB: { prepare },
            } as never,
            {} as never,
        );

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            error: "Error: no such table",
        });
    });
});

describe("r2", () => {
    const object = (body: string) => ({
        body,
        httpEtag: '"abc"',
        writeHttpMetadata: (headers: Headers) =>
            headers.set("Content-Type", "text/plain"),
    });

    it("GETs an object with its metadata", async () => {
        const get = vi.fn().mockResolvedValue(object("hello"));
        const response = await r2("FILES").handle(
            new Request("http://example.com/a.txt"),
            {
                FILES: { get },
            } as never,
            {} as never,
        );

        expect(get).toHaveBeenCalledWith("a.txt");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
        expect(response.headers.get("Content-Type")).toBe("text/plain");
    });

    it("404s missing keys", async () => {
        const get = vi.fn().mockResolvedValue(null);
        const response = await r2("FILES").handle(
            new Request("http://example.com/missing"),
            {
                FILES: { get },
            } as never,
            {} as never,
        );

        expect(response.status).toBe(404);
    });

    it("HEADs metadata headers", async () => {
        const head = vi.fn().mockResolvedValue({
            ...object(""),
            size: 42,
            uploaded: new Date("2026-01-01T00:00:00Z"),
        });
        const response = await r2("FILES").handle(
            new Request("http://example.com/a.txt", { method: "HEAD" }),
            {
                FILES: { head },
            } as never,
            {} as never,
        );

        expect(response.headers.get("Content-Length")).toBe("42");
        expect(response.headers.get("Last-Modified")).toBe(
            "Thu, 01 Jan 2026 00:00:00 GMT",
        );
    });

    it("PUTs with the content type", async () => {
        const put = vi.fn().mockResolvedValue(undefined);
        await r2("FILES").handle(
            new Request("http://example.com/a.txt", {
                body: "data",
                headers: { "Content-Type": "text/plain" },
                method: "PUT",
            }),
            { FILES: { put } } as never,
            {} as never,
        );

        expect(put).toHaveBeenCalledWith("a.txt", expect.anything(), {
            httpMetadata: { contentType: "text/plain" },
        });
    });

    it("DELETEs a batch when the body lists keys", async () => {
        const del = vi.fn().mockResolvedValue(undefined);
        await r2("FILES").handle(
            new Request("http://example.com/", {
                body: JSON.stringify({ keys: ["a", "b"] }),
                method: "DELETE",
            }),
            { FILES: { delete: del } } as never,
            {} as never,
        );

        expect(del).toHaveBeenCalledWith(["a", "b"]);
    });

    it("lists with pagination params", async () => {
        const list = vi.fn().mockResolvedValue({
            cursor: "next",
            objects: [{ key: "a", size: 1 }],
            truncated: true,
        });
        const response = await r2("FILES").handle(
            new Request(
                "http://example.com/?list&prefix=pub&limit=5&cursor=cur",
            ),
            { FILES: { list } } as never,
            {} as never,
        );

        expect(list).toHaveBeenCalledWith({
            cursor: "cur",
            limit: 5,
            prefix: "pub",
        });
        expect(await response.json()).toEqual({
            cursor: "next",
            objects: [{ key: "a", size: 1 }],
            truncated: true,
        });
    });
});

describe("mail", () => {
    it("sends one message per recipient", async () => {
        const send = vi.fn().mockResolvedValue(undefined);
        const response = await mail("EMAIL").handle(
            jsonRequest("http://example.com/send", {
                from: "noreply@x.dev",
                subject: "Hi",
                text: "body",
                to: ["a@x.dev", "b@x.dev"],
            }),
            { EMAIL: { send } } as never,
            {} as never,
        );

        expect(send).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
    });

    it("answers 500 when sending fails", async () => {
        const send = vi.fn().mockRejectedValue(new Error("sender not allowed"));
        const response = await mail("EMAIL").handle(
            jsonRequest("http://example.com/send", {
                from: "x@x.dev",
                subject: "",
                to: ["a@x.dev"],
            }),
            { EMAIL: { send } } as never,
            {} as never,
        );

        expect(response.status).toBe(500);
    });
});

describe("log", () => {
    it("answers ok and tees the body to the sink when set", async () => {
        const tee = vi.fn().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", tee);
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const response = await log({ sink: "http://logs.internal/" }).handle(
            new Request("http://example.com/", {
                body: "boot output",
                method: "POST",
            }),
            {} as never,
            {} as never,
        );

        expect(response.status).toBe(200);
        expect(tee).toHaveBeenCalledWith("http://logs.internal/", {
            body: "boot output",
            method: "POST",
        });
        vi.unstubAllGlobals();
    });

    it("still answers ok when the sink is down", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new Error("connection refused")),
        );
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const response = await log({ sink: "http://logs.internal/" }).handle(
            new Request("http://example.com/", {
                body: "boot output",
                method: "POST",
            }),
            {} as never,
            {} as never,
        );

        expect(response.status).toBe(200);
        vi.unstubAllGlobals();
    });
});

describe("phpOutbound", () => {
    const env = {
        DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn() }) },
        EMAIL: { send: vi.fn() },
        FILES: { get: vi.fn().mockResolvedValue(null) },
    };

    const handlerFor = (map: Record<string, OutboundHandler | undefined>) => {
        const handler = map["example.com"];
        if (handler === undefined) throw new Error("missing handler");
        return handler;
    };

    it("routes every factory under one shared host", () => {
        const map = phpOutbound(d1("DB"), r2("FILES"), mail("EMAIL"), log());

        expect(Object.keys(map)).toEqual(["example.com"]);
    });

    it("honours a custom shared host", () => {
        const map = phpOutbound({ host: "outbound.internal" }, d1("DB"));

        expect(Object.keys(map)).toEqual(["outbound.internal"]);
    });

    it("dispatches by binding-name path and strips the prefix", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const handler = handlerFor(
            phpOutbound(d1("DB"), r2("FILES"), mail("EMAIL"), log()),
        );

        await handler(
            jsonRequest("http://example.com/DB/query", { sql: "SELECT 1" }),
            env as never,
            {} as never,
        );
        expect(env.DB.prepare).toHaveBeenCalledWith("SELECT 1");

        const r2Response = await handler(
            new Request("http://example.com/FILES/a.txt"),
            env as never,
            {} as never,
        );
        expect(env.FILES.get).toHaveBeenCalledWith("a.txt");
        expect(r2Response.status).toBe(404);

        const mailResponse = await handler(
            jsonRequest("http://example.com/EMAIL/send", {
                from: "x@x.dev",
                subject: "",
                text: "body",
                to: ["a@x.dev"],
            }),
            env as never,
            {} as never,
        );
        expect(mailResponse.status).toBe(200);
        expect(env.EMAIL.send).toHaveBeenCalledTimes(1);

        const logResponse = await handler(
            new Request("http://example.com/log", {
                body: "boot output",
                method: "POST",
            }),
            env as never,
            {} as never,
        );
        expect(logResponse.status).toBe(200);
    });

    it("does not match partial path segments", async () => {
        const handler = handlerFor(phpOutbound(d1("DB")));

        const response = await handler(
            jsonRequest("http://example.com/DB2/query", { sql: "SELECT 1" }),
            env as never,
            {} as never,
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            error: "workers-php: no outbound route for /DB2/query",
        });
    });

    it("throws on duplicate paths", () => {
        expect(() => phpOutbound(d1("DB"), d1("DB"))).toThrow(
            'workers-php: duplicate outbound path "/DB"',
        );
    });
});
