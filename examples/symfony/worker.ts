// Worker entrypoint for the Symfony example (this directory). The D1
// binding is used directly via $env->DB in the counter controller;
// APP_ENV surfaces to the Symfony runtime via $_SERVER.

import {createPhpHandler} from "workers-php";

export default {
	fetch: createPhpHandler({
		docroot: "public",
		entrypoint: "index.php",
		bindings: {
			DB:      "d1",
			APP_ENV: "var",
		},
	}),
};
