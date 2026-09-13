// Worker entrypoint for the Slim example (this directory). The D1
// binding is used directly via $env->DB; APP_ENV surfaces to PHP as
// `$env->APP_ENV`.

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
