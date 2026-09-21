import postgres from "postgres";

import type { Outbound } from "./container";
import type { KeyOf } from "./env";

import { binding } from "./container";

/**
 * Speaks the D1 query protocol against a Hyperdrive binding, so the PHP
 * runtime reuses D1HttpClient and the HttpD1PDO family unchanged:
 *
 *   POST {endpoint}/query  {"sql": "...", "params": [...]}  → {results, success, meta}
 *   POST {endpoint}/exec   {"sql": "..."}                   → {"count": n}
 *
 * `?` placeholders are rewritten to Postgres's `$n` (single-quoted
 * strings are left alone); the jsonb `?` operator family must be
 * written as jsonb_exists(), jsonb_exists_any() or jsonb_exists_all().
 * Requires the `postgres` package and the `nodejs_compat` flag.
 */
export const hyperdrive = <K extends KeyOf<Hyperdrive>>(
    name: K,
): Outbound<Record<K, Hyperdrive>> => ({
    handle: async (request, env) => {
        try {
            const hd = binding(env, name);
            const url = new URL(request.url);
            const body = (await request.json()) as {
                params?: unknown[];
                sql: string;
            };
            const sql = postgres(hd.connectionString, {
                fetch_types: false,
                max: 5,
            });
            try {
                if (url.pathname === "/exec") {
                    const rows = await sql.unsafe(
                        toDollarPlaceholders(body.sql),
                    );
                    return Response.json({ count: rows.count ?? 0 });
                }
                const rows = await sql.unsafe(
                    toDollarPlaceholders(body.sql),
                    (body.params ?? []) as never,
                );
                return Response.json({
                    meta: { changes: rows.count ?? rows.length },
                    results: rows,
                    success: true,
                });
            } finally {
                await sql.end();
            }
        } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
        }
    },
    path: `/${name}`,
});

/**
 * Rewrite `?` placeholders to Postgres's `$n`, numbered in order of
 * appearance; text inside single-quoted strings (with '' escapes) is
 * left alone.
 */
export const toDollarPlaceholders = (input: string): string => {
    let out = "";
    let index = 0;
    let inString = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (inString) {
            out += ch;
            if (ch === "'" && input[i + 1] === "'") {
                out += "'";
                i++;
                continue;
            }
            if (ch === "'") inString = false;
            continue;
        }
        if (ch === "'") {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === "?") {
            index++;
            out += `$${index}`;
            continue;
        }
        out += ch;
    }
    return out;
};
