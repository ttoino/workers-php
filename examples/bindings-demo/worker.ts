// Worker entrypoint for the workers-php bindings demo.
//
// Each binding declared in this directory's wrangler.jsonc surfaces to
// PHP via the `$env` superglobal:
//
//     $env->DB       → \WorkersPHP\D1Database   (binding type "d1")
//     $env->IMAGES   → \WorkersPHP\R2Bucket     (binding type "r2")
//     $env->KV       → \WorkersPHP\KVNamespace  (binding type "kv")
//     $env->APP_ENV  → string                   (binding type "var")
//
// Uploaded images live in the R2 bucket and are served directly via a
// `staticRoutes` entry under `/uploads/`, with a fallback to ASSETS for
// any static files the PHP project happens to ship at the same prefix.

import {createPhpHandler} from "workers-php";

export default {
	fetch: createPhpHandler({
		docroot: ".",
		entrypoint: "router.php",
		bindings: {
			DB:      "d1",
			IMAGES:  "r2",
			KV:      "kv",
			APP_ENV: "var",
		},
		staticRoutes: [
			{pathPrefix: "/uploads/", from: "IMAGES"},
		],
	}),
};
