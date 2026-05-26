import {PhpWeb} from "../wasm/PhpWeb.mjs";
import phpWasm from "../wasm/php-web.wasm";

import indexPhp from "../php/index.php";
import infoPhp from "../php/info.php";
import helloPhp from "../php/hello.php";

type OutputEvent = CustomEvent<string[] | string>;

const routes: Record<string, string> = {
	"/": indexPhp,
	"/index.php": indexPhp,
	"/info": infoPhp,
	"/info.php": infoPhp,
	"/hello": helloPhp,
	"/hello.php": helloPhp,
};

// ---------- Singleton PhpWeb instance, lazily initialized per isolate ----------

let phpInstance: PhpWeb | null = null;

const getPhp = (): PhpWeb => {
	if (!phpInstance) {
		phpInstance = new PhpWeb({
			instantiateWasm(
				info: WebAssembly.Imports,
				receive: (instance: WebAssembly.Instance) => void,
			) {
				const instance = new WebAssembly.Instance(phpWasm, info);
				receive(instance);
				return instance.exports;
			},
			locateFile: () => undefined,
		});
	}
	return phpInstance;
};

// ---------- Per-isolate serialization ----------
//
// PHP has global state. Even with refresh() between runs, we must not interleave
// requests through the same instance. Chain handlers through a single promise.

let requestChain: Promise<unknown> = Promise.resolve();

const withPhpLock = <T>(fn: () => Promise<T>): Promise<T> => {
	const next = requestChain.then(fn, fn);
	// Swallow rejections on the chain so one failing request doesn't poison the next.
	requestChain = next.catch(() => undefined);
	return next;
};

// ---------- Superglobals injection ----------
//
// php.run(code) just runs PHP code; it doesn't know about HTTP. We construct a
// prelude that seeds $_SERVER/$_GET/$_POST/$_COOKIE from the request, then
// concatenate the user's PHP source.

const phpQuoteString = (s: string): string =>
	"'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

const phpArrayLiteral = (entries: Iterable<[string, string]>): string => {
	const parts: string[] = [];
	for (const [k, v] of entries) {
		parts.push(`${phpQuoteString(k)} => ${phpQuoteString(v)}`);
	}
	return `[${parts.join(", ")}]`;
};

const parseCookies = (header: string | null): Map<string, string> => {
	const out = new Map<string, string>();
	if (!header) return out;
	for (const piece of header.split(";")) {
		const eq = piece.indexOf("=");
		if (eq < 0) continue;
		const k = piece.slice(0, eq).trim();
		const v = piece.slice(eq + 1).trim();
		if (k) out.set(k, decodeURIComponent(v));
	}
	return out;
};

const parseFormUrlEncoded = (body: string): Map<string, string> => {
	const out = new Map<string, string>();
	const params = new URLSearchParams(body);
	for (const [k, v] of params) {
		out.set(k, v);
	}
	return out;
};

const buildPrelude = async (request: Request): Promise<string> => {
	const url = new URL(request.url);

	const get = new Map<string, string>();
	for (const [k, v] of url.searchParams) get.set(k, v);

	const post = new Map<string, string>();
	let rawBody = "";
	const method = request.method.toUpperCase();
	if (method === "POST" || method === "PUT" || method === "PATCH") {
		rawBody = await request.text();
		const ct = request.headers.get("content-type") ?? "";
		if (ct.includes("application/x-www-form-urlencoded")) {
			for (const [k, v] of parseFormUrlEncoded(rawBody)) post.set(k, v);
		}
	}

	const cookies = parseCookies(request.headers.get("cookie"));

	const server: [string, string][] = [
		["REQUEST_METHOD", method],
		["REQUEST_URI", url.pathname + url.search],
		["QUERY_STRING", url.search.replace(/^\?/, "")],
		["HTTP_HOST", url.host],
		["SERVER_NAME", url.hostname],
		["SERVER_PORT", url.port || (url.protocol === "https:" ? "443" : "80")],
		["HTTPS", url.protocol === "https:" ? "on" : "off"],
		["REQUEST_SCHEME", url.protocol.replace(/:$/, "")],
		["REMOTE_ADDR", request.headers.get("cf-connecting-ip") ?? "127.0.0.1"],
		["SERVER_SOFTWARE", "php-wasm-worker"],
		["SCRIPT_NAME", url.pathname],
		["CONTENT_LENGTH", String(rawBody.length)],
		["CONTENT_TYPE", request.headers.get("content-type") ?? ""],
		["USER_AGENT", request.headers.get("user-agent") ?? ""],
	];

	// Headers as HTTP_*
	for (const [k, v] of request.headers) {
		const upper = k.toUpperCase().replace(/-/g, "_");
		server.push([`HTTP_${upper}`, v]);
	}

	// Note: no closing `?>` and no trailing whitespace — anything after `?>`
	// becomes output, triggering "headers already sent" on subsequent header()
	// calls in the route file.
	return `<?php
$_SERVER = array_merge($_SERVER ?? [], ${phpArrayLiteral(server)});
$_GET = ${phpArrayLiteral(get)};
$_POST = ${phpArrayLiteral(post)};
$_COOKIE = ${phpArrayLiteral(cookies)};
$_REQUEST = array_merge($_GET, $_POST, $_COOKIE);`;
};

// ---------- Output capture and header parsing ----------
//
// PhpWeb emits 'output' (stdout) and 'error' (stderr) CustomEvents. PHP's
// header() calls become "Header: value\n" lines at the start of stdout when
// using the embed SAPI without a CGI wrapper. We parse a leading header block
// (terminated by a blank line) out of the buffered output to derive the
// Response status and headers, treating the rest as the body.

interface CapturedOutput {
	body: string;
	headers: Headers;
	status: number;
}

const parseOutput = (stdout: string): CapturedOutput => {
	const headers = new Headers();
	let status = 200;

	// PHP's embed SAPI doesn't emit a CGI-style header block on stdout by default;
	// header() calls are buffered separately and don't actually appear here. So
	// the simplest, most reliable thing to do is pass the entire stdout as body
	// and let PHP handle its own Content-Type via output. If the body looks like
	// a CGI response (starts with "Header: value\r?\n"), we parse it.
	const cgiHeaderBlock = /^(?:[A-Za-z0-9!#$%&'*+\-.^_`|~]+:[^\n]*\r?\n)+\r?\n/;
	const match = stdout.match(cgiHeaderBlock);
	if (match) {
		const headerBlock = match[0];
		const body = stdout.slice(headerBlock.length);
		for (const line of headerBlock.trimEnd().split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			const name = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (/^status$/i.test(name)) {
				const m = value.match(/^(\d{3})/);
				if (m) status = Number(m[1]);
				continue;
			}
			headers.append(name, value);
		}
		return {body, headers, status};
	}

	return {body: stdout, headers, status};
};

// ---------- Per-request runner ----------

const runRequest = async (request: Request): Promise<Response> => {
	const url = new URL(request.url);
	const route = routes[url.pathname] ?? routes["/"];

	const php = getPhp();

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

	php.addEventListener("output", onStdout);
	php.addEventListener("error", onStderr);

	try {
		await php.binary;
		// Reset PHP global state between requests (clears variables, output buffers, etc.)
		await php.refresh();

		const prelude = await buildPrelude(request);
		// Wrap the route in output buffering so we can emit a CGI-style header
		// block (Header: value\n...\n\n<body>) that parseOutput() picks up.
		// Steps:
		//   1) Run prelude (PHP mode, no closing `?>`), then `?>` to leave PHP
		//      mode, then start ob_start in PHP mode again to buffer the route.
		//   2) The route runs and may call header(), echo, etc.
		//   3) After the route, flush a header block built from headers_list()
		//      and then the buffered body.
		// Wrap the route in output buffering so we can emit a CGI-style header
		// block (Header: value\n...\n\n<body>) that parseOutput() picks up.
		//
		// The route file's content runs inside ob_start(). After it completes,
		// we force PHP mode (via `<?php`) and run the epilogue regardless of
		// whether the route ended in PHP mode or HTML mode.
		const epilogue = `<?php
$__body = ob_get_clean();
$__headers = headers_list();
foreach ($__headers as $__h) { echo $__h, "\\r\\n"; }
echo "\\r\\n", $__body;`;
		// Strip the route's own leading `<?php` so we can stay in PHP mode
		// after the prelude and ob_start(). Append `?>` then re-open with the
		// epilogue's `<?php` so we end in PHP mode regardless of how the route
		// finished.
		const routeBody = route.replace(/^\s*<\?php\s*/, "");
		const code =
			prelude +
			`\nob_start();\n` +
			routeBody +
			"\n?>" +
			epilogue;
		await php.run(code);
		php.flush();
	} finally {
		php.removeEventListener("output", onStdout);
		php.removeEventListener("error", onStderr);
	}

	const stdout = stdoutChunks.join("");
	const stderr = stderrChunks.join("");

	if (stderr.length) {
		console.warn("[php stderr]", stderr);
	}

	const {body, headers, status} = parseOutput(stdout);
	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", "text/html; charset=utf-8");
	}

	return new Response(body, {status, headers});
};

// ---------- Worker entrypoint ----------

export default {
	async fetch(request, _env, _ctx): Promise<Response> {
		try {
			return await withPhpLock(() => runRequest(request));
		} catch (e) {
			const err = e as Error;
			console.error("[worker] error:", err);
			return new Response(
				`Worker error:\n${err?.stack ?? String(err)}`,
				{status: 500, headers: {"Content-Type": "text/plain; charset=utf-8"}},
			);
		}
	},
} satisfies ExportedHandler<Env>;
