import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	server: {
		watch: {
			// Composer-installed PHP vendor trees (examples/laravel/vendor
			// has thousands of files); watching them stalls pool startup.
			ignored: ["**/vendor/**"],
		},
	},
	test: {
		// Default test discovery; explicitly scope to our package and the demo
		// so vitest doesn't pick up test files from .build-cache/php-wasm/.
		include: ["packages/*/test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
		exclude: [
			"**/node_modules/**",
			"**/.build-cache/**",
			"**/dist/**",
		],
		// Composer-installed PHP vendor trees (examples/laravel/vendor has
		// thousands of files); watching them stalls pool startup.
		watchExclude: ["**/vendor/**"],
		poolOptions: {
			workers: {
				// The demo example's config: compatibility settings + the
				// Data rule that lets specs import dist-*/app.tar.gz.
				wrangler: { configPath: "./examples/demo/wrangler.jsonc" },
				// Each wasm-heavy spec compiles the 33 MB php-web.wasm in
				// its own workerd; running them in parallel got CI jobs
				// canceled. Serialize on CI only.
				...(process.env.CI ? { singleWorker: true } : {}),
			},
		},
	},
});
