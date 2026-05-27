// Demo Worker showing how to consume the `workers-php` library.
//
// The PHP project served by this Worker lives in ./php/. The build step
// (`npm run build-php`) bundles it into ./dist/app.tar.gz, which Wrangler
// uploads as a Workers ASSET. The handler below fetches that tarball from
// the ASSETS binding on the first request, mounts it into the PHP wasm
// filesystem, and dispatches every subsequent HTTP request through
// `public/index.php`.
//
// See packages/workers-php/README.md for the full API.

import {createPhpHandler} from "workers-php";

const php = createPhpHandler({
	// The demo PHP project doesn't follow Laravel's public/ convention —
	// each route is its own .php file at the top level. We point docroot
	// at the project root and let the public router decide what to serve.
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
