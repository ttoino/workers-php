import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		// Default test discovery; explicitly scope to our package and the demo
		// so vitest doesn't pick up test files from .build-cache/php-wasm/.
		include: ["packages/*/test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
		exclude: [
			"**/node_modules/**",
			"**/.build-cache/**",
			"**/dist/**",
		],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				// CI runners die (job canceled) when the wasm-heavy spec
				// files spin up workerd + compile the 33 MB php-web.wasm in
				// parallel. Serialize them on CI only; local runs stay
				// parallel.
				...(process.env.CI ? { singleWorker: true } : {}),
			},
		},
	},
});
