// Laravel smoke test: boot the built examples/laravel tarball end to end.
// D1 is emulated in-process with page_hits semantics (INSERT rows land,
// COUNT(*) reflects them); everything else — wasm boot, tarball mount,
// Laravel's kernel, the D1ServiceProvider shim, Blade — runs for real.
//
// Requires dist-laravel/app.tar.gz (npm run build:laravel); skipped
// otherwise. CI builds it before running vitest.

import {describe, expect, it} from "vitest";
import {createPhpHandler} from "../src/index";
import {makeMockAssets} from "./helpers";
// Data module via the pool's modulesRules. Static: dynamic imports skip
// the externalizer, so the tarball must exist — run `npm run
// build:laravel` before the suite (CI does).
import appTarGz from "../../../dist-laravel/app.tar.gz";

const makePageHitsD1 = () => {
	const rows: {id: number; path: string; created_at: string}[] = [];
	const stmt = (sql: string, params: unknown[]) => ({
		async run() {
			// The PDO path (lib.php D1PDOStatement) routes every statement
			// through d1_run, so branch on the SQL shape here.
			if (/^\s*insert/i.test(sql)) {
				rows.push({
					id: rows.length + 1,
					path: String(params[0] ?? ""),
					created_at: "",
				});
				return {
					results: [],
					success: true,
					meta: {duration: 0.1, last_row_id: rows.length, changes: 1},
				};
			}
			if (/count\(\*\)\s+as\s+"?aggregate"?/i.test(sql)) {
				return {
					results: [{aggregate: rows.length}],
					success: true,
					meta: {duration: 0.1, last_row_id: 0, changes: 0},
				};
			}
			return {
				results: rows.map((r) => ({...r})),
				success: true,
				meta: {duration: 0.1, last_row_id: 0, changes: 0},
			};
		},
		async all() {
			return this.run();
		},
		async first() {
			return rows[0] ?? null;
		},
		async raw() {
			return rows.map((r) => Object.values(r));
		},
	});
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return stmt(sql, params);
				},
				...stmt(sql, []),
			};
		},
		async batch() {
			return [];
		},
		async exec() {
			return {count: 0, duration: 0};
		},
	};
};

const hitCount = (html: string): number => {
	const m = html.match(/Page hits[\s\S]*?<strong>(\d+)<\/strong>/);
	if (!m) throw new Error("hit counter not found in response");
	return Number(m[1]);
};

describe("examples/laravel (built tarball)", () => {
	it(
		"boots stock Laravel and serves the D1-backed counter",
		async () => {
			const env = {
				ASSETS: makeMockAssets(new Uint8Array(appTarGz)),
				DB: makePageHitsD1(),
				APP_ENV: "testing",
			};
			const handler = createPhpHandler({
				appRoot: "/persist/laravel-smoke",
				docroot: "public",
				entrypoint: "index.php",
				bindings: {DB: "d1", APP_ENV: "var"},
			});
			const execCtx = {
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext;

			const first = await handler(
				new Request("https://example.com/"),
				env,
				execCtx,
			);
			expect(first.status).toBe(200);
			const firstHtml = await first.text();
			expect(firstHtml).toContain("Stock Laravel 13.");
			expect(hitCount(firstHtml)).toBe(1);

			const second = await handler(
				new Request("https://example.com/"),
				env,
				execCtx,
			);
			expect(hitCount(await second.text())).toBe(2);
		},
		240000,
	);
});
