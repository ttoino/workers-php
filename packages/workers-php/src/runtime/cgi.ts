// CGI-style superglobal injection and stdout header parsing.
//
// The PHP runtime we use is `embed` SAPI — there's no CGI wrapper. We
// synthesize the `$_SERVER`, `$_GET`, `$_POST`, `$_COOKIE` arrays in a PHP
// prelude before calling the user's entrypoint, and on the way out we ask
// PHP to emit its `headers_list()` + `http_response_code()` as a CGI-style
// header block on stdout that we then parse out of the captured output.

export const phpQuoteString = (s: string): string =>
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
	for (const [k, v] of params) out.set(k, v);
	return out;
};

export interface PreludeOptions {
	scriptFilename?: string;
	scriptName?: string;
	requestUri?: string;
	documentRoot?: string;
	envOverrides?: Record<string, string>;
	/**
	 * Whether to set `display_errors=1` in the prelude. Default `true`.
	 * Set to `false` for production-style deployments where you don't want
	 * PHP warnings/notices leaking into HTML response bodies.
	 */
	displayErrors?: boolean;
	/**
	 * Raw PHP expression assigned to `error_reporting(...)`. Default
	 * `"E_ALL"`. Common alternatives: `"E_ERROR | E_PARSE"` (silence
	 * notices/warnings/deprecations), `"0"` (silence everything).
	 */
	errorReporting?: string;
}

/**
 * Build the PHP prelude that seeds superglobals from the incoming Request.
 * Returns PHP source code that should be prepended (still inside `<?php`)
 * to the user's entrypoint invocation.
 */
export const buildPrelude = async (
	request: Request,
	opts: PreludeOptions = {},
): Promise<string> => {
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
		["REQUEST_URI", opts.requestUri ?? url.pathname + url.search],
		["QUERY_STRING", url.search.replace(/^\?/, "")],
		["HTTP_HOST", url.host],
		["SERVER_NAME", url.hostname],
		["SERVER_PORT", url.port || (url.protocol === "https:" ? "443" : "80")],
		["HTTPS", url.protocol === "https:" ? "on" : "off"],
		["REQUEST_SCHEME", url.protocol.replace(/:$/, "")],
		["REMOTE_ADDR", request.headers.get("cf-connecting-ip") ?? "127.0.0.1"],
		["SERVER_SOFTWARE", "workers-php"],
		["SERVER_PROTOCOL", "HTTP/1.1"],
		["GATEWAY_INTERFACE", "CGI/1.1"],
		["SCRIPT_NAME", opts.scriptName ?? url.pathname],
		["CONTENT_LENGTH", String(rawBody.length)],
		["CONTENT_TYPE", request.headers.get("content-type") ?? ""],
		["USER_AGENT", request.headers.get("user-agent") ?? ""],
	];
	if (opts.scriptFilename) server.push(["SCRIPT_FILENAME", opts.scriptFilename]);
	if (opts.documentRoot) server.push(["DOCUMENT_ROOT", opts.documentRoot]);

	for (const [k, v] of request.headers) {
		const upper = k.toUpperCase().replace(/-/g, "_");
		server.push([`HTTP_${upper}`, v]);
	}

	// Build per-request putenv() calls for envOverrides. Note: at mount-time
	// we also write the merged values into <appRoot>/.env so PHP libraries
	// that read it directly (Laravel's vlucas/phpdotenv) get them too.
	let putEnvLines = "";
	if (opts.envOverrides) {
		for (const [k, v] of Object.entries(opts.envOverrides)) {
			putEnvLines += `putenv(${phpQuoteString(`${k}=${v}`)});\n`;
		}
	}

	const displayErrors = opts.displayErrors ?? true;
	const errorReporting = opts.errorReporting ?? "E_ALL";

	// No closing `?>` — anything after that would become output and trigger
	// "headers already sent" errors on later header() calls in user code.
	return `<?php
$_SERVER = array_merge($_SERVER ?? [], ${phpArrayLiteral(server)});
$_GET = ${phpArrayLiteral(get)};
$_POST = ${phpArrayLiteral(post)};
$_COOKIE = ${phpArrayLiteral(cookies)};
$_REQUEST = array_merge($_GET, $_POST, $_COOKIE);
${putEnvLines}ini_set('display_errors', ${phpQuoteString(displayErrors ? "1" : "0")});
error_reporting(${errorReporting});`;
};

export interface CapturedOutput {
	body: string;
	headers: Headers;
	status: number;
}

/**
 * Extract the CGI-style "Header: value\r\n...\r\n\r\nBODY" block(s)
 * from captured stdout and produce headers/status/body for the Response.
 *
 * Why multiple blocks may appear: the embed SAPI in our php-wasm build
 * sometimes emits its own header block via `sapi_send_headers()` at the
 * end of a request (in addition to the one our ob_start callback writes
 * via `buildShutdown`). The duplicate is identical, so we just consume
 * every leading CGI block we find and let the last one win.
 */
export const parseOutput = (stdout: string): CapturedOutput => {
	const headers = new Headers();
	let status = 200;

	const cgiHeaderBlock = /^(?:[A-Za-z0-9!#$%&'*+\-.^_`|~]+:[^\n]*\r?\n)+\r?\n/;
	let remaining = stdout;
	let matched = false;
	// Consume every leading CGI block. The first iteration handles the
	// expected case; further iterations cope with the SAPI's duplicate.
	// Cap the loop to avoid pathological inputs.
	for (let i = 0; i < 4; i++) {
		const match = remaining.match(cgiHeaderBlock);
		if (!match) break;
		matched = true;
		// Reset headers; later block wins.
		for (const k of [...headers.keys()]) headers.delete(k);
		for (const line of match[0].trimEnd().split(/\r?\n/)) {
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
		remaining = remaining.slice(match[0].length);
	}

	return matched ? {body: remaining, headers, status} : {body: stdout, headers, status};
};

/**
 * PHP source that wraps the entrypoint in an output-buffer callback so
 * the response framing (Status + headers + body) survives every script
 * termination path: normal return, throw, and exit/die.
 *
 * The callback receives the entire buffered body and returns the
 * fully-framed CGI block, which PHP then emits as the actual stdout.
 * Crucially, ob_start callbacks fire **after** all shutdown functions,
 * meaning `session_write_close` has already run and `headers_list()`
 * includes the `Set-Cookie: PHPSESSID=...` header.
 *
 * `chunk_size = 0` and the absence of `PHP_OUTPUT_HANDLER_FLUSHABLE`
 * means the callback only fires when the buffer is finally flushed at
 * shutdown — not on every interim `flush()` the user code might call.
 */
export const buildShutdown = (): string => `
ob_start(function ($__body) {
    $__out = '';
    $__status = http_response_code();
    if (is_int($__status)) $__out .= "Status: $__status\\r\\n";
    foreach (headers_list() as $__h) $__out .= $__h . "\\r\\n";
    $__out .= "\\r\\n" . $__body;
    return $__out;
});
`;

/**
 * @deprecated kept for backwards compatibility; prefer buildShutdown() at
 * the top of the script so output framing survives exit/die.
 */
export const buildEpilogue = (): string => `<?php
$__body = ob_get_clean();
$__status = http_response_code();
if (is_int($__status)) echo "Status: $__status\\r\\n";
foreach (headers_list() as $__h) echo $__h, "\\r\\n";
echo "\\r\\n", $__body;`;
