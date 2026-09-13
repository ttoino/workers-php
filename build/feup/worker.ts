// Worker entrypoint for ttoino/feup-ltw-proj (xaufome), copied into the
// project dir by build-feup.sh.
//
// `npm run build-feup` clones the project into ./feup-ltw-proj, overlays
// a router plus D1/R2-backed replacements (see build/build-feup.sh for
// the list), and bundles the tree into ./dist-feup/app.tar.gz.
//
// Persistence: relational data → D1 (env.DB via \WorkersPHP\D1PDO);
// uploaded images → R2 (env.IMAGES), served back via `staticRoutes`.

import {createPhpHandler} from "workers-php";

const php = createPhpHandler({
	docroot: ".",
	entrypoint: "router.php",
	// `webmanifest` (from <link rel="manifest">) isn't in the default
	// static allowlist; entries here have no leading dot.
	extraStaticExtensions: ["webmanifest"],
	// PHP 8.1-era code on 8.5 floods deprecation notices and
	// undefined-variable warnings; keep anything below E_ERROR out of
	// the rendered HTML.
	displayErrors: false,
	errorReporting: "E_ERROR | E_PARSE",
	bindings: {
		DB:     "d1",
		IMAGES: "r2",
	},
	// Persist sessions to D1 so logins survive isolate recycles; the
	// table is created on first use.
	sessionHandler: {
		backend: "d1",
		from:    "DB",
	},
	// Uploads live in R2; until the bucket has an object, missRewrite
	// swaps the URL to the ASSETS placeholder so pages still render.
	staticRoutes: [{
		pathPrefix: "/assets/pictures/",
		from: "IMAGES",
		missRewrite: (pathname) => {
			return pathname.replace(/\/[0-9]+\.webp$/, "/default.svg");
		},
	}],
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return php(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
