// Worker entrypoint for ttoino/feup-ltw-proj (xaufome).
//
// The PHP project is cloned (gitignored) into ./feup-ltw-proj. The build
// step (`npm run build-feup`) overlays:
//
//   * router.php           — Apache-style front controller
//   * lib/session.php      — cookie_secure conditional on HTTPS
//   * database/connection.php  — getDBConnection() returns \WorkersPHP\D1PDO($env->DB)
//   * lib/files.php        — uploadImage() writes to R2 (env->IMAGES)
//   * cart/index.php       — adds the missing require_once('../lib/page.php')
//
// then bundles the tree into ./dist-feup/app.tar.gz which Wrangler
// uploads as a Workers ASSET.
//
// Persistence:
//   * Relational data → Cloudflare D1 via env.DB (\WorkersPHP\D1PDO)
//   * Uploaded images → Cloudflare R2 via env.IMAGES (\WorkersPHP\R2Bucket)
//   * /assets/pictures/<type>/<id>.webp is served straight from R2 via
//     `staticRoutes`, with `missRewrite` falling back to the project's
//     `default*.svg` placeholders shipped in ASSETS.
//
// Known limitations (acceptable for this iteration):
//   * Outbound HTTP from PHP is not available (the curl extension isn't
//     compiled into the bundled wasm); the app doesn't need it.

import {createPhpHandler} from "workers-php";

const php = createPhpHandler({
	docroot: ".",
	entrypoint: "router.php",
	// `webmanifest` is referenced from <link rel="manifest"> in templates
	// but isn't in the library's default static-extension allowlist.
	// (Extensions in this list are without the leading dot.)
	extraStaticExtensions: ["webmanifest"],
	// The project was written against PHP 8.1; running it on 8.5 produces a
	// flood of `Deprecated: Implicitly marking parameter ... as nullable`
	// notices, plus undefined-variable warnings on the index page when not
	// logged in. We silence everything below E_ERROR so it doesn't get
	// dumped into the rendered HTML.
	displayErrors: false,
	errorReporting: "E_ERROR | E_PARSE",
	// Bindings exposed to PHP via $env.
	bindings: {
		DB:     "d1",
		IMAGES: "r2",
	},
	// Persist PHP sessions to D1 so the login flow survives Worker isolate
	// recycles. The library auto-registers a SessionHandlerD1, and the
	// `workers_php_sessions` table is created on first use.
	sessionHandler: {
		backend: "d1",
		from:    "DB",
	},
	// Serve user-uploaded restaurant/dish/menu/user images from R2. The
	// project still ships `default*.svg` placeholders in ASSETS — when
	// R2 has no <id>.webp yet, missRewrite swaps the URL to default.svg
	// before falling back to ASSETS so the page still renders.
	staticRoutes: [{
		pathPrefix: "/assets/pictures/",
		from: "IMAGES",
		missRewrite: (pathname) => {
			// /assets/pictures/<type>/<id>.webp → /assets/pictures/<type>/default.svg
			return pathname.replace(/\/[0-9]+\.webp$/, "/default.svg");
		},
	}],
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return php(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
