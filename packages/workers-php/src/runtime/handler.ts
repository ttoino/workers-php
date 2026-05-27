// createPhpHandler — the consumer-facing factory. Returns a Worker fetch
// handler that mounts a PHP project from the ASSETS binding on first
// request and dispatches every subsequent HTTP request through that
// project's entrypoint.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import {setBridgeMethods, type BridgeMethods} from "./bridge";
import {BodyTooLargeError, buildPrelude, buildShutdown, parseOutput, phpQuoteString} from "./cgi";
import {ensureMounted, RUNTIME_LIBRARY_PATH} from "./mount";
import {ensureDir, getPhp, withPhpLock, type PhpBinary} from "./php-instance";
import {DEFAULT_STATIC_EXTENSIONS, isStaticRequest} from "./static";

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

	// Install the bridge dispatch table for this request. Static methods
	// from `options.bridgeMethods` plus per-request closures from
	// `bridgeMethodsForRequest(request, env)` (the latter wins on
	// collision). Idempotent; mutates Module.workersPhpBridge in place.
	const perRequest = options.bridgeMethodsForRequest
		? options.bridgeMethodsForRequest(request, env)
		: {};
	await setBridgeMethods(php, {...options.bridgeMethods, ...perRequest});

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

		// Stage uploaded multipart files into the wasm FS so PHP can access
		// `$_FILES[...]['tmp_name']` via `file_get_contents`, `fopen`, etc.
		const uploadDir = "/tmp";
		ensureDir(binary.FS, uploadDir);
		for (const f of prelude.stagedFiles) {
			try {
				binary.FS.writeFile(f.path, f.bytes);
			} catch (err) {
				options.onLog("stderr", `workers-php: failed to stage ${f.path}: ${(err as Error).message}\n`);
			}
		}

		// Write the raw request body to a known path so our userland
		// php:// stream wrapper (installed by RUNTIME_LIBRARY_PATH) can
		// surface it via `file_get_contents('php://input')`. Always
		// (re)write — including a zero-byte file for requests with no
		// body — so the wrapper sees the current request's bytes.
		try {
			binary.FS.writeFile(INPUT_TMP_PATH, prelude.stdinBytes);
		} catch (err) {
			options.onLog("stderr", `workers-php: failed to seed php://input: ${(err as Error).message}\n`);
		}

		// The shutdown function is registered FIRST so output framing also
		// survives `exit`/`die` in user code.
		const code =
			prelude.phpSource +
			buildShutdown() +
			`
chdir(${phpQuoteString(documentRoot)});
try {
    require ${phpQuoteString(scriptFilename)};
} catch (\\Throwable $__e) {
    while (ob_get_level() > 1) ob_end_clean();
    http_response_code(500);
    echo "<pre>workers-php: uncaught PHP error\\n", htmlspecialchars((string)$__e), "</pre>";
}
`;

		await php.run(code);
		php.flush();

		// Best-effort cleanup of staged tmpfiles. We do this AFTER PHP runs
		// so the script can still `file_get_contents($tmp_name)` etc.
		for (const f of prelude.stagedFiles) {
			try {
				const fs = binary.FS as {unlink?: (p: string) => void};
				if (typeof fs.unlink === "function") fs.unlink(f.path);
			} catch {
				// Ignore — leave dangling tmpfile, MEMFS will be wiped on
				// isolate recycle anyway.
			}
		}
	} finally {
		// Cleanup happens via capture.stop() below.
	}

	const {stdout} = capture.stop();
	const {body, headers, status} = parseOutput(stdout);
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

			// Static-file short-circuit. Bypasses PHP entirely.
			if (
				!opts.disableStaticShortCircuit &&
				isStaticRequest(new URL(request.url).pathname, opts.staticExtensions)
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
