// Demo Worker consuming the `workers-php` library.
//
// `npm run build-php` bundles this directory's ./php/ into the repo-root
// dist/app.tar.gz, which Wrangler uploads as a Workers ASSET. On first
// request the handler mounts it into the PHP wasm FS; each request is
// dispatched through router.php.
//
// See packages/workers-php/README.md for the full API.

import {createPhpHandler} from "workers-php";

const php = createPhpHandler({
	// The demo project has no public/ convention — each route is its own
	// top-level .php file — so docroot is the project root.
	docroot: ".",
	entrypoint: "router.php",
	envOverrides: {
		APP_ENV: "demo",
	},
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return php(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
