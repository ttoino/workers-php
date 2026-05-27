// createPhpHandler — the consumer-facing factory. Returns a Worker fetch
// handler that mounts a PHP project from the ASSETS binding on first
// request and dispatches every subsequent HTTP request through that
// project's entrypoint.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import {buildPrelude, buildShutdown, parseOutput, phpQuoteString} from "./cgi";
import {ensureMounted} from "./mount";
import {getPhp, withPhpLock} from "./php-instance";
import {DEFAULT_STATIC_EXTENSIONS, isStaticRequest} from "./static";

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
	options: ResolvedOptions,
): Promise<Response> => {
	const url = new URL(request.url);
	const php = getPhp();

	const scriptFilename = `${options.appRoot}/${options.docroot}/${options.entrypoint}`;
	const documentRoot = `${options.appRoot}/${options.docroot}`;

	const capture = collectOutput(php, options.onLog);
	capture.start();
	try {
		await php.binary;
		await php.refresh();

		const prelude = await buildPrelude(request, {
			scriptFilename,
			scriptName: "/" + options.entrypoint,
			requestUri: url.pathname + url.search,
			documentRoot,
			envOverrides: options.envOverrides,
			displayErrors: options.displayErrors,
			errorReporting: options.errorReporting,
		});

		// The shutdown function is registered FIRST so output framing also
		// survives `exit`/`die` in user code (which would skip any code
		// after the require). It opens its own ob_start() so we can
		// collect all output, including content written from inside
		// shutdown handlers registered by the user script.
		const code =
			prelude +
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
	} finally {
		// Cleanup happens via capture.stop() below; nothing else.
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
				return await runPhp(request, opts);
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
