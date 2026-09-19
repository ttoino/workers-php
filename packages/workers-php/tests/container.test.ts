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
            jsonRequest("http://db.app/query", {
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
            jsonRequest("http://db.app/query", { sql: "SELECT 1" }),
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
            jsonRequest("http://db.app/exec", {
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
            jsonRequest("http://db.app/query", { sql: "SELECT 1" }),
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
            new Request("http://files.app/a.txt"),
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
            new Request("http://files.app/missing"),
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
            new Request("http://files.app/a.txt", { method: "HEAD" }),
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
            new Request("http://files.app/a.txt", {
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
            new Request("http://files.app/", {
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
            new Request("http://files.app/?list&prefix=pub&limit=5&cursor=cur"),
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
            jsonRequest("http://email.app/send", {
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
            jsonRequest("http://email.app/send", {
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

describe("phpOutbound", () => {
    it("derives hosts from binding names", () => {
        const map = phpOutbound(d1("DB"), r2("FILES"), mail("EMAIL"), log());

        expect(Object.keys(map).sort()).toEqual([
            "db.app",
            "email.app",
            "files.app",
            "log.app",
        ]);
    });

    it("honours host overrides", () => {
        const map = phpOutbound(d1("DB", { host: "primary.internal" }));

        expect(Object.keys(map)).toEqual(["primary.internal"]);
    });
});
