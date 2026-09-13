// Laravel smoke test: boot the built examples/laravel tarball end to end.
// D1 is emulated in-process with page_hits semantics; everything else —
// wasm boot, tarball mount, Laravel's kernel, the D1ServiceProvider shim,
// Blade — runs for real.
//
// Requires examples/laravel/dist/app.tar.gz (npm run build:laravel). CI
// before running vitest.

import {describe, expect, it} from "vitest";
import {createPhpHandler} from "../src/index";
import {hitCount, makeMockAssets, makePageHitsD1, mockCtx} from "./helpers";
// Data module via the pool's modulesRules. Static: dynamic imports skip
// the externalizer, so the tarball must exist — run `npm run
// build:laravel` before the suite (CI does).
import appTarGz from "../../../examples/laravel/dist/app.tar.gz";

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

			const first = await handler(
				new Request("https://example.com/"),
				env,
				mockCtx,
			);
			expect(first.status).toBe(200);
			const firstHtml = await first.text();
			expect(firstHtml).toContain("Stock Laravel 13.");
			expect(hitCount(firstHtml)).toBe(1);

			const second = await handler(
				new Request("https://example.com/"),
				env,
				mockCtx,
			);
			expect(hitCount(await second.text())).toBe(2);
		},
		240000,
	);
});
