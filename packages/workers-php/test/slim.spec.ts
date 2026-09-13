// Slim smoke test: boot the built examples/slim tarball end to end. D1
// is emulated in-process with page_hits semantics; Slim's router and the
// direct $env->DB access run for real.
//
// Requires examples/slim/dist/app.tar.gz (npm run build:slim). CI
// before running vitest.

import {describe, expect, it} from "vitest";
import {createPhpHandler} from "../src/index";
import {hitCount, makeMockAssets, makePageHitsD1, mockCtx} from "./helpers";
import appTarGz from "../../../examples/slim/dist/app.tar.gz";

describe("examples/slim (built tarball)", () => {
	it(
		"boots Slim 4 and serves the D1-backed counter",
		async () => {
			const env = {
				ASSETS: makeMockAssets(new Uint8Array(appTarGz)),
				DB: makePageHitsD1(),
				APP_ENV: "testing",
			};
			const handler = createPhpHandler({
				appRoot: "/persist/slim-smoke",
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
			expect(firstHtml).toContain("Stock Slim 4.");
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
