// Worker entrypoint for ttoino/feup-ltw-proj (xaufome).
//
// The PHP project is cloned (gitignored) into ./feup-ltw-proj. The build
// step (`npm run build-feup`) (a) constructs main.db from the project's
// SQLite schema, (b) overlays a small Apache-style router.php into the
// project root, (c) patches lib/session.php so HTTP local dev keeps
// sessions, then (d) bundles the whole tree into ./dist-feup/app.tar.gz
// which Wrangler uploads as a Workers ASSET. The handler below dispatches
// every HTTP request through that router.
//
// Known limitations (acceptable for this experiment):
//   - DB writes (registration, reviews, cart) survive only within one
//     isolate. When the isolate is recycled, state reverts to the
//     populated baseline shipped in main.db.
//   - Sessions are PHP-file-based in /tmp inside the in-memory FS, so
//     they share the same lifetime as DB writes.
//   - Outbound HTTP from PHP is not available (the curl extension isn't
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
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return php(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
