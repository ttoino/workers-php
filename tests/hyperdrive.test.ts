import { beforeEach, describe, expect, it } from "vitest";

import { hyperdrive, toDollarPlaceholders } from "../src/hyperdrive";
import { captured } from "./stubs/postgres";

const jsonRequest = (url: string, body: unknown) =>
    new Request(url, { body: JSON.stringify(body), method: "POST" });

const env = {
    HYPERDRIVE: { connectionString: "postgres://hd.local/db" },
} as never;

beforeEach(() => {
    captured.calls.length = 0;
    captured.connectionString = undefined;
});

describe("toDollarPlaceholders", () => {
    it("numbers placeholders in order", () => {
        expect(
            toDollarPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"),
        ).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    });

    it("leaves single-quoted strings alone", () => {
        expect(toDollarPlaceholders("SELECT 'lit?ral', 'it''s ?', ?")).toBe(
            "SELECT 'lit?ral', 'it''s ?', $1",
        );
    });
});

describe("hyperdrive", () => {
    it("connects with the binding's connection string", async () => {
        await hyperdrive("HYPERDRIVE").handle(
            jsonRequest("http://example.com/query", { sql: "SELECT 1" }),
            env,
            {} as never,
        );

        expect(captured.connectionString).toBe("postgres://hd.local/db");
    });

    it("rewrites placeholders and forwards params", async () => {
        const response = await hyperdrive("HYPERDRIVE").handle(
            jsonRequest("http://example.com/query", {
                params: [1, "x"],
                sql: "SELECT * FROM t WHERE a = ? AND b = ?",
            }),
            env,
            {} as never,
        );

        expect(response.status).toBe(200);
        expect(captured.calls[0]?.sql).toBe(
            "SELECT * FROM t WHERE a = $1 AND b = $2",
        );
        expect(captured.calls[0]?.params).toEqual([1, "x"]);

        const body = (await response.json()) as {
            meta: { changes: number };
            results: unknown[];
            success: boolean;
        };
        expect(body.success).toBe(true);
        expect(body.results).toHaveLength(1);
        expect(body.meta.changes).toBe(1);
    });

    it("routes /exec to a count-only response", async () => {
        const response = await hyperdrive("HYPERDRIVE").handle(
            jsonRequest("http://example.com/exec", {
                sql: "CREATE TABLE t (id int)",
            }),
            env,
            {} as never,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ count: 1 });
        expect(captured.calls[0]?.params).toBeUndefined();
    });
});
