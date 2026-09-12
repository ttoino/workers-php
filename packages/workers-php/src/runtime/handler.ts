// createPhpHandler — the consumer-facing factory. Returns a Worker fetch
// handler that mounts a PHP project from the ASSETS binding on first
// request and dispatches every subsequent HTTP request through that
// project's entrypoint.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import {buildEnvDeclaration, buildSessionDeclaration, makeBindingDispatch} from "./bindings";
import {setBridgeMethods, type BridgeMethods} from "./bridge";
import {BodyTooLargeError, buildCapture, buildPrelude, makeCaptureSlot, phpQuoteString} from "./cgi";
import {ensureMounted, RUNTIME_LIBRARY_PATH} from "./mount";
import {ensureDir, getPhp, withPhpLock, type PhpBinary} from "./php-instance";
import {DEFAULT_STATIC_EXTENSIONS, isStaticRequest} from "./static";

/** Binding type identifiers, parallel to wrangler.jsonc binding kinds. */
export type BindingKind = "d1" | "r2" | "kv" | "var" | "secret";

/** Map from binding name (matches wrangler.jsonc and the user's env) to
 *  binding kind. Names are exposed to PHP via `$env-><Name>`. */
export type BindingDeclarations = Record<string, BindingKind>;

/** URL-path prefix that should be served by a specific R2 binding rather
 *  than the default ASSETS short-circuit. R2 misses fall through to
 *  ASSETS (unless `fallbackToAssets: false`). */
export interface StaticRoute {
	pathPrefix: string;
	from: string;
	fallbackToAssets?: boolean;
	/**
	 * On R2 miss, rewrite the request path before falling back to ASSETS.
	 * Useful for serving a stable placeholder (e.g. {id}.webp → default.svg)
	 * from ASSETS when the bucket has no object yet. Return null/undefined
	 * to skip the rewrite (default behaviour: try ASSETS with the original
	 * path).
	 */
	missRewrite?: (pathname: string) => string | null | undefined;
}

/**
 * Make PHP `$_SESSION` persist beyond a single isolate by writing through
 * a Cloudflare binding instead of the default file-backed handler in
 * `/tmp` MEMFS. The library auto-registers the chosen handler via
 * `session_set_save_handler($handler, true)` in the prelude — your PHP
 * code keeps calling `session_start()` exactly as before.
 */
export interface SessionHandlerConfig {
	/** Which backend persists the session blob. */
	backend: "d1" | "kv";
	/** Binding name (must match `bindings: { … }`). */
	from: string;
	/** D1 only: table name. Default `"workers_php_sessions"`. The table
	 *  is auto-created on first use. */
	table?: string;
	/** KV only: key prefix. Default `"sess:"`. */
	keyPrefix?: string;
	/** Session expiry in seconds. Default `86400` (24 h). */
	ttlSeconds?: number;
	/** Set `ini_set('session.use_strict_mode', '1')` so cookies with
	 *  unknown ids force a fresh one. Default `true`. Mitigates session
	 *  fixation. */
	strictMode?: boolean;
}

const INPUT_TMP_PATH = "/tmp/workers-php-input";

type OutputEvent = CustomEvent<string[] | string>;

export interface PhpHandlerOptions {
	/** Absolute path on the wasm FS where the app will be mounted.
	 *  Default: `"/persist/app"`. */
	appRoot?: string;

	/** Relative path under `appRoot` to the document root (entry directory).
	 *  Default: `"public"`. */
	docroot?: string;

	/** Filename inside `docroot` to require for every request.
	 *  Default: `"index.php"`. */
	entrypoint?: string;

	/** Name of the ASSETS binding to use. Default: `"ASSETS"`. */
	assetsBinding?: string;

	/** URL path inside the ASSETS bucket where the app tarball lives.
	 *  Default: `"/app.tar.gz"`. The `workers-php build` CLI writes its
	 *  output here. */
	appAssetPath?: string;

	/** When extracting the tarball, strip this leading directory from each
	 *  entry's name. Default: `"app"` (matching the CLI's tarball layout). */
	stripPrefix?: string;

	/** File extensions whose requests are forwarded straight to the ASSETS
	 *  binding without invoking PHP. Default: see DEFAULT_STATIC_EXTENSIONS. */
	staticExtensions?: readonly string[];

	/** Extra static extensions to allow on top of the defaults. */
	extraStaticExtensions?: readonly string[];

	/** Disable static-file short-circuiting entirely (everything goes to PHP). */
	disableStaticShortCircuit?: boolean;

	/** `.env` keys to override before mounting (writes to <appRoot>/.env) and
	 *  also `putenv()`-injected each request. Use for Worker-side secrets/vars. */
	envOverrides?: Record<string, string>;

	/** Set PHP's `display_errors` ini for each request. Default `true` — good
	 *  for development, but PHP warnings/notices leak into HTML response
	 *  bodies. Set to `false` for production. */
	displayErrors?: boolean;

	/** Raw PHP expression passed to `error_reporting(...)`. Default
	 *  `"E_ALL"`. Use e.g. `"E_ERROR | E_PARSE"` to silence notices,
	 *  warnings and deprecations. */
	errorReporting?: string;

	/** Maximum request body bytes the handler will buffer. Requests larger
	 *  than this return 413 Payload Too Large without invoking PHP.
	 *  Default: 50_000_000 (~50 MB). */
	maxBodyBytes?: number;

	/** Methods exposed on `Module.workersPhpBridge` for PHP code to call
	 *  via the bundled `workers_php_call($method, $args)` function. Per-
	 *  request bridge methods (e.g. ones that close over `env.DB`) can
	 *  also be set via the `bridgeMethodsForRequest(request, env)` hook. */
	bridgeMethods?: BridgeMethods;

	/** Per-request bridge methods. Combined with `bridgeMethods` on each
	 *  request; this one wins on key collision. Use to close over the
	 *  Worker's `env` for binding-backed dispatch (D1, R2, KV, …). */
	bridgeMethodsForRequest?: (request: Request, env: unknown) => BridgeMethods;

	/** Cloudflare bindings exposed to PHP code as `$env-><Name>`. Each
	 *  declared binding must also exist on the Worker's `env` parameter
	 *  with a matching type (D1Database, R2Bucket, KVNamespace, or a
	 *  string for `var`/`secret`). */
	bindings?: BindingDeclarations;

	/** URL prefixes routed to a binding's `Fetcher`-like surface before
	 *  the default static-extension short-circuit. Currently supports R2
	 *  bindings — requests under `pathPrefix` are looked up in the bucket
	 *  by key (URL path minus the leading slash). */
	staticRoutes?: readonly StaticRoute[];

	/** Persist `$_SESSION` to a Cloudflare binding (D1 or KV) so sessions
	 *  survive isolate recycles. When set, the library calls
	 *  `session_set_save_handler(…, true)` in the prelude — your PHP
	 *  `session_start()` calls keep working unchanged. */
	sessionHandler?: SessionHandlerConfig;

	/** Optional log hook. Default: console.warn for stderr only. */
	onLog?: (level: "stdout" | "stderr" | "mount", text: string) => void;
}

interface ResolvedOptions {
	appRoot: string;
	docroot: string;
	entrypoint: string;
	assetsBinding: string;
	appAssetPath: string;
	stripPrefix: string;
	staticExtensions: readonly string[];
	disableStaticShortCircuit: boolean;
	envOverrides: Record<string, string>;
	displayErrors: boolean;
	errorReporting: string;
	maxBodyBytes: number;
	bridgeMethods: BridgeMethods;
	bridgeMethodsForRequest:
		| ((request: Request, env: unknown) => BridgeMethods)
		| undefined;
	bindings: BindingDeclarations;
	staticRoutes: readonly StaticRoute[];
	sessionHandler: SessionHandlerConfig | undefined;
	onLog: (level: "stdout" | "stderr" | "mount", text: string) => void;
}

const resolveOptions = (o: PhpHandlerOptions = {}): ResolvedOptions => {
	const exts = new Set<string>(o.staticExtensions ?? DEFAULT_STATIC_EXTENSIONS);
	if (o.extraStaticExtensions) for (const e of o.extraStaticExtensions) exts.add(e);
	return {
		appRoot: (o.appRoot ?? "/persist/app").replace(/\/$/, ""),
		docroot: (o.docroot ?? "public").replace(/^\/+|\/+$/g, ""),
		entrypoint: (o.entrypoint ?? "index.php").replace(/^\/+/, ""),
		assetsBinding: o.assetsBinding ?? "ASSETS",
		appAssetPath: o.appAssetPath ?? "/app.tar.gz",
		stripPrefix: o.stripPrefix ?? "app",
		staticExtensions: [...exts],
		disableStaticShortCircuit: o.disableStaticShortCircuit ?? false,
		envOverrides: o.envOverrides ?? {},
		displayErrors: o.displayErrors ?? true,
		errorReporting: o.errorReporting ?? "E_ALL",
		maxBodyBytes: o.maxBodyBytes ?? 50_000_000,
		bridgeMethods: o.bridgeMethods ?? {},
		bridgeMethodsForRequest: o.bridgeMethodsForRequest,
		bindings: o.bindings ?? {},
		staticRoutes: o.staticRoutes ?? [],
		sessionHandler: o.sessionHandler,
		onLog:
			o.onLog ??
			((level, text) => {
				if (level === "stderr") console.warn("[php]", text);
				else if (level === "mount") console.log("[workers-php]", text);
			}),
	};
};

const collectOutput = (
	php: PhpWeb,
	onLog: ResolvedOptions["onLog"],
): {start: () => void; stop: () => {stdout: string; stderr: string}} => {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const onStdout = (event: Event) => {
		const detail = (event as OutputEvent).detail;
		const text = Array.isArray(detail) ? detail.join("") : String(detail ?? "");
		if (text.length) stdoutChunks.push(text);
	};
	const onStderr = (event: Event) => {
		const detail = (event as OutputEvent).detail;
		const text = Array.isArray(detail) ? detail.join("") : String(detail ?? "");
		if (text.length) stderrChunks.push(text);
	};

	return {
		start: () => {
			php.addEventListener("output", onStdout);
			php.addEventListener("error", onStderr);
		},
		stop: () => {
			php.removeEventListener("output", onStdout);
			php.removeEventListener("error", onStderr);
			const stdout = stdoutChunks.join("");
			const stderr = stderrChunks.join("");
			if (stderr.length) onLog("stderr", stderr);
			return {stdout, stderr};
		},
	};
};

const runPhp = async (
	request: Request,
	env: unknown,
	options: ResolvedOptions,
): Promise<Response> => {
	const url = new URL(request.url);
	const php = getPhp();

	// Layered bridge dispatch for this request: __set_capture, built-in
	// binding handlers, static bridgeMethods, per-request closures.
	// Later layers win on key collision.
	const {slot: captureSlot, bridgeMethod: captureBridgeMethod} = makeCaptureSlot();
	const builtin = makeBindingDispatch(env, options.bindings);
	const perRequest = options.bridgeMethodsForRequest
		? options.bridgeMethodsForRequest(request, env)
		: {};
	await setBridgeMethods(php, {
		__set_capture: captureBridgeMethod,
		...builtin,
		...options.bridgeMethods,
		...perRequest,
	});

	const scriptFilename = `${options.appRoot}/${options.docroot}/${options.entrypoint}`;
	const documentRoot = `${options.appRoot}/${options.docroot}`;

	const capture = collectOutput(php, options.onLog);
	capture.start();
	try {
		const binary = (await php.binary) as PhpBinary;
		await php.refresh();

		let prelude;
		try {
			prelude = await buildPrelude(request, {
				scriptFilename,
				scriptName: "/" + options.entrypoint,
				requestUri: url.pathname + url.search,
				documentRoot,
				envOverrides: options.envOverrides,
				displayErrors: options.displayErrors,
				errorReporting: options.errorReporting,
				maxBodyBytes: options.maxBodyBytes,
				runtimeLibraryPath: RUNTIME_LIBRARY_PATH,
				envDeclaration: Object.keys(options.bindings).length
					? buildEnvDeclaration(env, options.bindings)
					: "",
				sessionDeclaration: options.sessionHandler
					? buildSessionDeclaration(options.bindings, options.sessionHandler)
					: "",
			});
		} catch (e) {
			if (e instanceof BodyTooLargeError) {
				capture.stop();
				return new Response(
					`Request body too large: ${e.received} B exceeds limit ${e.limit} B`,
					{status: 413, headers: {"Content-Type": "text/plain; charset=utf-8"}},
				);
			}
			throw e;
		}

		// Stage uploads so PHP can read `$_FILES[...]['tmp_name']`.
		const uploadDir = "/tmp";
		ensureDir(binary.FS, uploadDir);
		for (const f of prelude.stagedFiles) {
			try {
				binary.FS.writeFile(f.path, f.bytes);
			} catch (err) {
				options.onLog("stderr", `workers-php: failed to stage ${f.path}: ${(err as Error).message}\n`);
			}
		}

		// Seed the file backing the php://input stream wrapper. Rewrite
		// unconditionally — even with zero bytes — so a stale body never
		// leaks into the next request.
		try {
			binary.FS.writeFile(INPUT_TMP_PATH, prelude.stdinBytes);
		} catch (err) {
			options.onLog("stderr", `workers-php: failed to seed php://input: ${(err as Error).message}\n`);
		}

		// The capture-ob is registered first so the response is captured
		// on every exit path: normal end, exit()/die() (zend_bailout
		// flushes ob buffers), or uncaught exception.
		//
		// pib_run() never runs php_request_shutdown() — that only happens
		// at the next request's pib_refresh() — so session_write_close()
		// is called explicitly, or session writes wouldn't land until the
		// following request.
		//
		// die() skips PHP-userland cleanup after the bailout point, so on
		// that path the explicit close is missed and PHP's automatic
		// close-on-shutdown (during the next pib_refresh) is the fallback.
		const code =
			prelude.phpSource +
			buildCapture() +
			`
chdir(${phpQuoteString(documentRoot)});
register_shutdown_function(function () {
    // Fires on normal end, exit() and fatal errors; the ob flush makes
    // the capture callback run and populate $GLOBALS.
    if (\\function_exists('session_status') && \\session_status() === PHP_SESSION_ACTIVE) {
        try { \\session_write_close(); } catch (\\Throwable $__) {}
    }
    while (\\ob_get_level() > 0) {
        try { @\\ob_end_flush(); } catch (\\Throwable $__) { break; }
    }
});
try {
    require ${phpQuoteString(scriptFilename)};
} catch (\\Throwable $__e) {
    while (\\ob_get_level() > 1) \\ob_end_clean();
    \\http_response_code(500);
    echo "<pre>workers-php: uncaught PHP error\\n", \\htmlspecialchars((string)$__e), "</pre>";
}
// pib_run never reaches PHP shutdown, so a normal return needs the same
// close+flush here; the shutdown function above only covers exit()/die().
if (\\function_exists('session_status') && \\session_status() === PHP_SESSION_ACTIVE) {
    try { \\session_write_close(); } catch (\\Throwable $__) {}
}
while (\\ob_get_level() > 0) {
    try { @\\ob_end_flush(); } catch (\\Throwable $__) { break; }
}
`;

		await php.run(code);
		php.flush();

		// Unlink only after PHP ran — the script may read $tmp_name during
		// execution. Leftovers are wiped with MEMFS on isolate recycle.
		for (const f of prelude.stagedFiles) {
			try {
				const fs = binary.FS as {unlink?: (p: string) => void};
				if (typeof fs.unlink === "function") fs.unlink(f.path);
			} catch {
				// Best effort.
			}
		}
	} finally {
		// FIXME: capture.stop() below only runs on the happy path; a throw
		// inside this block leaks the output/error event listeners onto the
		// shared PhpWeb instance for the isolate's lifetime.
	}

	capture.stop();

	const captured = captureSlot.value;
	const body = captured?.body ?? "";
	const status = captured?.status ?? 200;
	const headers = captured?.headers ?? new Headers();
	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", "text/html; charset=utf-8");
	}
	return new Response(body, {status, headers});
};

/**
 * A Worker fetch handler. Compatible with `ExportedHandler<Env>['fetch']`
 * for any `Env` containing the configured ASSETS binding.
 */
// deno-fmt-ignore
export type PhpHandler = (
	request: Request,
	env: unknown,
	ctx: ExecutionContext,
) => Promise<Response>;

export const createPhpHandler = (
	options: PhpHandlerOptions = {},
): PhpHandler => {
	const opts = resolveOptions(options);

	return async (request, env, _ctx): Promise<Response> => {
		try {
			const envMap = env as Record<string, unknown> | null | undefined;
			const assets = envMap?.[opts.assetsBinding] as Fetcher | undefined;
			if (!assets || typeof assets.fetch !== "function") {
				return new Response(
					`workers-php: missing ASSETS binding '${opts.assetsBinding}'. ` +
						`Add an "assets" block with binding: "${opts.assetsBinding}" to wrangler.jsonc.`,
					{status: 500, headers: {"Content-Type": "text/plain; charset=utf-8"}},
				);
			}

			const url = new URL(request.url);

			// R2-backed static routes, checked before ASSETS and PHP. A
			// miss falls through, optionally via `missRewrite` (serving a
			// placeholder until the bucket has the object).
			for (const route of opts.staticRoutes) {
				if (url.pathname.startsWith(route.pathPrefix)) {
					const r2 = envMap?.[route.from] as
						| {get: (key: string) => Promise<{body: ReadableStream; httpEtag?: string; writeHttpMetadata?: (h: Headers) => void} | null>}
						| undefined;
					if (r2 && typeof r2.get === "function") {
						const key = url.pathname.slice(1);
						const obj = await r2.get(key);
						if (obj) {
							const headers = new Headers();
							if (typeof obj.writeHttpMetadata === "function") {
								obj.writeHttpMetadata(headers);
							}
							if (obj.httpEtag) headers.set("etag", obj.httpEtag);
							return new Response(obj.body, {headers});
						}
						if (route.fallbackToAssets === false) {
							return new Response("Not Found", {status: 404});
						}
						if (route.missRewrite) {
							const rewritten = route.missRewrite(url.pathname);
							if (rewritten && rewritten !== url.pathname) {
								const rewrittenUrl = new URL(url);
								rewrittenUrl.pathname = rewritten;
								return assets.fetch(new Request(rewrittenUrl, request));
							}
						}
					}
					break; // only the first matching route is consulted
				}
			}

			if (
				!opts.disableStaticShortCircuit &&
				isStaticRequest(url.pathname, opts.staticExtensions)
			) {
				return assets.fetch(request);
			}

			return await withPhpLock(async () => {
				const php = getPhp();
				await ensureMounted(php, assets, {
					appRoot: opts.appRoot,
					assetPath: opts.appAssetPath,
					stripPrefix: opts.stripPrefix,
					envOverrides: opts.envOverrides,
					log: (m) => opts.onLog("mount", m),
				});
				return await runPhp(request, env, opts);
			});
		} catch (err) {
			const e = err as Error;
			console.error("[workers-php] handler error:", e);
			return new Response(
				`workers-php: ${e?.stack ?? String(e)}`,
				{status: 500, headers: {"Content-Type": "text/plain; charset=utf-8"}},
			);
		}
	};
};
