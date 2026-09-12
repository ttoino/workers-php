// Worker entrypoint for the Laravel example (examples/laravel). The D1
// binding backs Laravel's custom `d1` database driver; APP_ENV surfaces
// to PHP as `$env->APP_ENV`.

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
