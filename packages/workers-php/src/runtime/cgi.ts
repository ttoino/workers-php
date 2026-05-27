// CGI-style superglobal injection and stdout header parsing.
//
// The PHP runtime we use is `embed` SAPI — there's no CGI wrapper. We
// synthesize the `$_SERVER`, `$_GET`, `$_POST`, `$_COOKIE`, `$_FILES`
// arrays in a PHP prelude before calling the user's entrypoint, and on
// the way out an `ob_start` callback emits the response as a CGI-style
// header block + body that `parseOutput` understands.

import {boundaryFromContentType, parseMultipart, type MultipartPart} from "./multipart";

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

const parseFormUrlEncoded = (body: string): Array<[string, string]> => {
	const out: Array<[string, string]> = [];
	const params = new URLSearchParams(body);
	for (const [k, v] of params) out.push([k, v]);
	return out;
};

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const utf8Decode = (bytes: Uint8Array): string =>
	new TextDecoder("utf-8").decode(bytes);

// ---------- PHP $_POST / $_FILES array shape ----------
//
// PHP collapses `foo[bar][baz]` keys into nested arrays in $_POST. We mirror
// that here so e.g. `name="favorites[]"` produces `$_POST['favorites'] = [...]`.

interface PhpScalarTree {
	[key: string]: string | string[] | PhpScalarTree;
}

const setNestedScalar = (target: PhpScalarTree, key: string, value: string): void => {
	// Parse `foo`, `foo[]`, `foo[bar]`, `foo[bar][]`, `foo[bar][baz]`, etc.
	const m = key.match(/^([^\[]+)(\[.*\])?$/);
	if (!m) return;
	const segments: Array<string | null> = [m[1]];
	const rest = m[2] ?? "";
	const re = /\[([^\]]*)\]/g;
	let sm: RegExpExecArray | null;
	while ((sm = re.exec(rest)) !== null) {
		segments.push(sm[1] === "" ? null : sm[1]);
	}

	let cursor: unknown = target;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const last = i === segments.length - 1;
		if (seg === null) {
			// Auto-index: append.
			if (!Array.isArray(cursor)) {
				// PHP would convert; treat the prior container as array if
				// it's empty, otherwise drop.
				return;
			}
			if (last) {
				cursor.push(value);
			} else {
				const next: PhpScalarTree = {};
				cursor.push(next as unknown as string);
				cursor = next;
			}
		} else {
			if (last) {
				(cursor as PhpScalarTree)[seg] = value;
			} else {
				const existing = (cursor as PhpScalarTree)[seg];
				if (existing && typeof existing === "object") {
					cursor = existing;
				} else {
					const next: PhpScalarTree = {};
					(cursor as PhpScalarTree)[seg] = next;
					cursor = next;
				}
			}
		}
	}
};

// PHP literal serialization of a tree built by setNestedScalar.
const phpArrayFromTree = (tree: unknown): string => {
	if (typeof tree === "string") return phpQuoteString(tree);
	if (Array.isArray(tree)) {
		const parts = tree.map((v) => phpArrayFromTree(v));
		return `[${parts.join(", ")}]`;
	}
	if (tree && typeof tree === "object") {
		const parts: string[] = [];
		for (const [k, v] of Object.entries(tree)) {
			parts.push(`${phpQuoteString(k)} => ${phpArrayFromTree(v)}`);
		}
		return `[${parts.join(", ")}]`;
	}
	return "null";
};

export interface StagedFile {
	/** Absolute path in the wasm FS where the bytes should be written. */
	path: string;
	bytes: Uint8Array;
}

export interface PreludeOptions {
	scriptFilename?: string;
	scriptName?: string;
	requestUri?: string;
	documentRoot?: string;
	envOverrides?: Record<string, string>;
	displayErrors?: boolean;
	errorReporting?: string;
	/** Max body bytes to read; if exceeded, prelude throws. */
	maxBodyBytes?: number;
	/** PHP expression injected before the user's entrypoint to declare
	 *  `$env`. The library builds this from `PhpHandlerOptions.bindings`. */
	envDeclaration?: string;
	/** PHP expression injected after `$env` to install a session save
	 *  handler. The library builds this from
	 *  `PhpHandlerOptions.sessionHandler`. Runs before any user
	 *  `session_start()`. */
	sessionDeclaration?: string;
	/** Path of the PHP runtime library to require_once before the entrypoint
	 *  (e.g. `/persist/workers-php-lib.php`). Empty string = none. */
	runtimeLibraryPath?: string;
	/** Where to stage uploaded files in the wasm FS. Default `/tmp`. */
	uploadTmpDir?: string;
}

export interface BuiltPrelude {
	/** Concatenated `<?php ...` source to prepend before the entrypoint. */
	phpSource: string;
	/** Files to write to the wasm FS before running the script. */
	stagedFiles: StagedFile[];
	/** Raw request body bytes (after maxBodyBytes capping) — push these
	 *  into stdin so `php://input` reads them. */
	stdinBytes: Uint8Array;
}

/** Thrown when the request body exceeds `maxBodyBytes`. The handler turns
 *  this into a 413 response. */
export class BodyTooLargeError extends Error {
	constructor(
		public readonly limit: number,
		public readonly received: number,
	) {
		super(`request body ${received} B exceeds limit ${limit} B`);
		this.name = "BodyTooLargeError";
	}
}

/**
 * Build the PHP prelude that seeds superglobals from the incoming Request.
 * Also stages multipart file parts as tmpfiles for $_FILES['tmp_name'].
 */
export const buildPrelude = async (
	request: Request,
	opts: PreludeOptions = {},
): Promise<BuiltPrelude> => {
	const url = new URL(request.url);
	const method = request.method.toUpperCase();
	const maxBodyBytes = opts.maxBodyBytes ?? 50_000_000;
	const uploadTmpDir = (opts.uploadTmpDir ?? "/tmp").replace(/\/$/, "");

	// $_GET
	const get = new Map<string, string>();
	for (const [k, v] of url.searchParams) get.set(k, v);

	// Read body (once). We always buffer the full body — multipart parsing
	// needs random access, and we also push the same bytes into stdin.
	let bodyBytes = new Uint8Array(0);
	let bodyHasContent = false;
	if (
		method === "POST" ||
		method === "PUT" ||
		method === "PATCH" ||
		method === "DELETE"
	) {
		const buf = await request.arrayBuffer();
		if (buf.byteLength > maxBodyBytes) {
			throw new BodyTooLargeError(maxBodyBytes, buf.byteLength);
		}
		bodyBytes = new Uint8Array(buf);
		bodyHasContent = bodyBytes.byteLength > 0;
	}

	// $_POST, $_FILES
	const postTree: PhpScalarTree = {};
	const filesTree: PhpScalarTree = {};
	const stagedFiles: StagedFile[] = [];
	const ct = request.headers.get("content-type") ?? "";

	if (bodyHasContent) {
		if (ct.includes("application/x-www-form-urlencoded")) {
			for (const [k, v] of parseFormUrlEncoded(utf8Decode(bodyBytes))) {
				setNestedScalar(postTree, k, v);
			}
		} else if (ct.toLowerCase().startsWith("multipart/form-data")) {
			const boundary = boundaryFromContentType(ct);
			if (boundary) {
				let parts: MultipartPart[];
				try {
					parts = parseMultipart(bodyBytes, boundary);
				} catch {
					parts = [];
				}
				let fileCounter = 0;
				const filesByName = new Map<string, MultipartPart[]>();
				for (const part of parts) {
					if (part.kind === "text") {
						setNestedScalar(postTree, part.name, part.value);
					} else {
						// Group file parts by bare name; PHP collapses
						// `name="x[]"`, `name="x[0]"`, `name="x[a]"` into
						// `$_FILES['x']['name']` arrays.
						const bareName = part.name.replace(/\[.*\]$/, "");
						if (!filesByName.has(bareName)) filesByName.set(bareName, []);
						filesByName.get(bareName)!.push(part);
						// Stage tmpfile regardless.
						const tmpPath = `${uploadTmpDir}/workers-php-upload-${++fileCounter}`;
						stagedFiles.push({path: tmpPath, bytes: (part as {bytes: Uint8Array}).bytes});
						(part as {tmpPath?: string}).tmpPath = tmpPath;
					}
				}

				// Populate $_FILES with PHP's array-or-scalar shape per
				// PHP's behavior: bracketed names produce array-of-X
				// metadata; bare names produce scalar metadata.
				for (const [bareName, group] of filesByName) {
					const bracketed = group.some((g) => g.name !== bareName);
					if (!bracketed && group.length === 1) {
						const f = group[0] as MultipartFilePartWithPath;
						filesTree[bareName] = {
							name: f.filename,
							type: f.contentType,
							tmp_name: f.tmpPath,
							error: "0",
							size: String(f.bytes.byteLength),
						};
					} else {
						const names: string[] = [];
						const types: string[] = [];
						const tmps: string[] = [];
						const errors: string[] = [];
						const sizes: string[] = [];
						for (const part of group) {
							const f = part as MultipartFilePartWithPath;
							names.push(f.filename);
							types.push(f.contentType);
							tmps.push(f.tmpPath);
							errors.push("0");
							sizes.push(String(f.bytes.byteLength));
						}
						filesTree[bareName] = {
							name: names,
							type: types,
							tmp_name: tmps,
							error: errors,
							size: sizes,
						};
					}
				}
			}
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
		["CONTENT_LENGTH", String(bodyBytes.byteLength)],
		["CONTENT_TYPE", ct],
		["USER_AGENT", request.headers.get("user-agent") ?? ""],
	];
	if (opts.scriptFilename) server.push(["SCRIPT_FILENAME", opts.scriptFilename]);
	if (opts.documentRoot) server.push(["DOCUMENT_ROOT", opts.documentRoot]);

	for (const [k, v] of request.headers) {
		const upper = k.toUpperCase().replace(/-/g, "_");
		server.push([`HTTP_${upper}`, v]);
	}

	// putenv() each request for envOverrides.
	let putEnvLines = "";
	if (opts.envOverrides) {
		for (const [k, v] of Object.entries(opts.envOverrides)) {
			putEnvLines += `putenv(${phpQuoteString(`${k}=${v}`)});\n`;
		}
	}

	const displayErrors = opts.displayErrors ?? true;
	const errorReporting = opts.errorReporting ?? "E_ALL";

	const envDeclaration = opts.envDeclaration ?? "";
	const sessionDeclaration = opts.sessionDeclaration ?? "";
	const runtimeRequire = opts.runtimeLibraryPath
		? `require_once ${phpQuoteString(opts.runtimeLibraryPath)};\n`
		: "";

	// $_POST and $_FILES are emitted using tree-aware serialization so that
	// bracketed names produce nested PHP arrays.
	//
	// The prelude starts with a defensive state-reset block. `pib_refresh`
	// (which the JS handler calls before each request) should already wipe
	// PHP-Zend state, but extra paranoia is cheap and avoids any residual
	// $_SESSION / http_response_code / headers_list / ob buffer state from
	// the previous request leaking into the new one.
	return {
		phpSource: `<?php
// --- defensive request-state reset ---
$_SESSION = [];
@http_response_code(200);
foreach (@headers_list() as $__h) {
    $__c = strpos($__h, ':');
    if ($__c !== false) @header_remove(substr($__h, 0, $__c));
}
while (@ob_get_level() > 0) @ob_end_clean();

// --- superglobals ---
$_SERVER = array_merge($_SERVER ?? [], ${phpArrayLiteral(server)});
$_GET = ${phpArrayLiteral(get)};
$_POST = ${phpArrayFromTree(postTree)};
$_FILES = ${phpArrayFromTree(filesTree)};
$_COOKIE = ${phpArrayLiteral(cookies)};
$_REQUEST = array_merge($_GET, $_POST, $_COOKIE);
${putEnvLines}ini_set('display_errors', ${phpQuoteString(displayErrors ? "1" : "0")});
error_reporting(${errorReporting});
${runtimeRequire}${envDeclaration}${sessionDeclaration}`,
		stagedFiles,
		stdinBytes: bodyBytes,
	};
};

// Internal augmented type used while building $_FILES — the multipart
// parser produces parts without `tmpPath`; we attach it after staging.
type MultipartFilePartWithPath = {
	kind: "file";
	name: string;
	filename: string;
	contentType: string;
	bytes: Uint8Array;
	tmpPath: string;
};

export interface CapturedOutput {
	body: string;
	headers: Headers;
	status: number;
}

/**
 * PHP source that installs an output-buffer callback which captures the
 * response status, headers and body and pushes them to JS via the
 * workers_php_bridge — INSTEAD of writing them to stdout as a CGI-style
 * block.
 *
 * Why bridge instead of stdout-framing OR a PHP global?
 *   * php-wasm's embed SAPI ships with `send_header` as a no-op, so the
 *     only way to learn what `header()` calls did is to snapshot
 *     `headers_list()` ourselves.
 *   * Stdout-framing is fragile in the face of warning output (display_errors=1
 *     prints notices straight into stdout), trailing whitespace after `?>`,
 *     and other "extra bytes before the header block" cases that would
 *     break a strict regex.
 *   * Capturing into a $GLOBALS variable and reading back via pib_exec
 *     fails on the `die()`/`exit()` paths: zend_bailout leaves the
 *     Zend engine in a partially-shutdown state, and any subsequent
 *     pib_exec call returns empty before the next pib_refresh.
 *   * The ob_start callback runs during pib_flush, BEFORE pib_run
 *     returns and BEFORE the engine state is touched by bailout
 *     cleanup. Pushing the snapshot through the bridge (which writes
 *     to a JS-side variable) means the result survives the bailout.
 */
export const buildCapture = (): string => `
ob_start(function ($__body) {
    @\\workers_php_call('__set_capture', [
        \\http_response_code() ?: 200,
        \\headers_list(),
        $__body,
    ]);
    return '';
});
`;

/**
 * Shape of the captured response, pushed JS-side by buildCapture's ob
 * callback via the workers_php_bridge.
 */
export interface CaptureSlot {
	value: CapturedOutput | null;
}

/**
 * Create a CaptureSlot + the bridge method that buildCapture's ob
 * callback will write into. Mount the returned method into the
 * bridge for this request via setBridgeMethods, then read
 * `slot.value` after pib_run returns.
 */
export const makeCaptureSlot = (): {
	slot: CaptureSlot;
	bridgeMethod: (status: number, headers: string[], body: string) => boolean;
} => {
	const slot: CaptureSlot = {value: null};
	const bridgeMethod = (
		status: number,
		headers: string[],
		body: string,
	): boolean => {
		const h = new Headers();
		for (const line of headers ?? []) {
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			const name = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (!name) continue;
			if (/^status$/i.test(name)) continue;
			h.append(name, value);
		}
		slot.value = {
			status: typeof status === "number" ? status : 200,
			headers: h,
			body: typeof body === "string" ? body : "",
		};
		return true;
	};
	return {slot, bridgeMethod};
};

/**
 * @deprecated kept for back-compat with tests. Use makeCaptureSlot +
 * the __set_capture bridge method instead — that approach survives
 * die()/exit() inside the user script because the snapshot leaves PHP
 * land before bailout cleanup tears down the Zend state.
 *
 * Reads the capture from $GLOBALS['__workers_php_capture'] via pib_exec.
 * Only works when the user script completed normally.
 */
export const readCapture = async (
	php: {exec: (code: string) => Promise<string | null | undefined>},
): Promise<CapturedOutput | null> => {
	const raw = await php.exec(
		"\\json_encode($GLOBALS['__workers_php_capture'] ?? null, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)",
	);
	if (raw == null || raw === "" || raw === "null") return null;

	let parsed: {status?: number; headers?: string[]; body?: string};
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch {
		return null;
	}
	if (!parsed) return null;

	const headers = new Headers();
	for (const line of parsed.headers ?? []) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const name = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!name) continue;
		if (/^status$/i.test(name)) continue;
		headers.append(name, value);
	}
	return {
		status: typeof parsed.status === "number" ? parsed.status : 200,
		headers,
		body: typeof parsed.body === "string" ? parsed.body : "",
	};
};

/**
 * @deprecated kept for back-compat. Use `buildCapture` + `readCapture`
 * which is robust against ob/SAPI ordering, leading whitespace, and
 * notice output in stdout.
 *
 * Extract the CGI-style "Header: value\r\n...\r\n\r\nBODY" block(s) from
 * captured stdout and produce headers/status/body for the Response.
 *
 * Our ob_start callback emits a block that ALWAYS starts with
 * `Status: <code>\r\n` plus PHP's header_list(). The embed SAPI in our
 * php-wasm build sometimes emits its OWN duplicate block (also
 * starting with X-Powered-By or similar) right before ours. To handle
 * both, we consume any leading block whose first line is `Status:` (our
 * own), and additionally consume one preceding block ONLY if it looks
 * SAPI-emitted (no Status:, contains X-Powered-By). User-written body
 * text that happens to contain colon-separated lines is left alone.
 */
export const parseOutput = (stdout: string): CapturedOutput => {
	const headers = new Headers();
	let status = 200;

	const cgiHeaderBlock = /^(?:[A-Za-z0-9!#$%&'*+\-.^_`|~]+:[^\n]*\r?\n)+\r?\n/;
	let remaining = stdout;

	// First leading block: try to match.
	const first = remaining.match(cgiHeaderBlock);
	if (!first) {
		return {body: stdout, headers, status};
	}

	// Is this the SAPI's leftover block? Skip it if so and try the next.
	const looksLikeSapiBlock = (block: string): boolean =>
		!/^Status:/im.test(block) && /^X-Powered-By:/im.test(block);

	let firstBlock = first[0];
	remaining = remaining.slice(firstBlock.length);
	if (looksLikeSapiBlock(firstBlock)) {
		const second = remaining.match(cgiHeaderBlock);
		if (second) {
			firstBlock = second[0];
			remaining = remaining.slice(second[0].length);
		}
	}

	for (const line of firstBlock.trimEnd().split(/\r?\n/)) {
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

	return {body: remaining, headers, status};
};

/**
 * @deprecated kept for back-compat. Use `buildCapture` + `readCapture`.
 *
 * The new implementation no longer emits CGI-style framing into stdout
 * (the embed SAPI's send_header is a no-op so framing has to come from
 * userland — and an ob_start callback that writes back to the buffer
 * fights with notices/whitespace/etc that PHP also writes to stdout).
 *
 * Returning buildCapture() preserves the entrypoint name for existing
 * callers but the new mechanism stores the captured response in a PHP
 * GLOBAL that `readCapture(php)` retrieves out-of-band via pib_exec.
 */
export const buildShutdown = (): string => buildCapture();

/**
 * @deprecated kept for back-compat; prefer buildShutdown().
 */
export const buildEpilogue = (): string => `<?php
$__body = ob_get_clean();
$__status = http_response_code();
if (is_int($__status)) echo "Status: $__status\\r\\n";
foreach (headers_list() as $__h) echo $__h, "\\r\\n";
echo "\\r\\n", $__body;`;
