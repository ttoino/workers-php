// Symfony smoke test: boot the built examples/symfony tarball end to
// end. D1 is emulated in-process with page_hits semantics; Symfony's
// runtime component, kernel, and attribute routing run for real.
//
// Requires examples/symfony/dist/app.tar.gz (npm run build:symfony). CI
// it before running vitest.

import {describe, expect, it} from "vitest";
import {createPhpHandler} from "../src/index";
import {hitCount, makeMockAssets, makePageHitsD1, mockCtx} from "./helpers";
import appTarGz from "../../../examples/symfony/dist/app.tar.gz";

describe("examples/symfony (built tarball)", () => {
	it(
		"boots the Symfony 7 skeleton and serves the D1-backed counter",
		async () => {
			const env = {
				ASSETS: makeMockAssets(new Uint8Array(appTarGz)),
				DB: makePageHitsD1(),
				APP_ENV: "prod",
			};
			const handler = createPhpHandler({
				appRoot: "/persist/symfony-smoke",
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
			expect(firstHtml).toContain("Stock Symfony 7.");
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
