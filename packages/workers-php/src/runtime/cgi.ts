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
	const runtimeRequire = opts.runtimeLibraryPath
		? `require_once ${phpQuoteString(opts.runtimeLibraryPath)};\n`
		: "";

	// $_POST and $_FILES are emitted using tree-aware serialization so that
	// bracketed names produce nested PHP arrays.
	return {
		phpSource: `<?php
$_SERVER = array_merge($_SERVER ?? [], ${phpArrayLiteral(server)});
$_GET = ${phpArrayLiteral(get)};
$_POST = ${phpArrayFromTree(postTree)};
$_FILES = ${phpArrayFromTree(filesTree)};
$_COOKIE = ${phpArrayLiteral(cookies)};
$_REQUEST = array_merge($_GET, $_POST, $_COOKIE);
${putEnvLines}ini_set('display_errors', ${phpQuoteString(displayErrors ? "1" : "0")});
error_reporting(${errorReporting});
${runtimeRequire}${envDeclaration}`,
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
	for (let i = 0; i < 4; i++) {
		const match = remaining.match(cgiHeaderBlock);
		if (!match) break;
		matched = true;
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
 * PHP source that wraps the entrypoint in an output-buffer callback so the
 * response framing (Status + headers + body) survives every script
 * termination path: normal return, throw, and exit/die.
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
 * @deprecated kept for back-compat; prefer buildShutdown().
 */
export const buildEpilogue = (): string => `<?php
$__body = ob_get_clean();
$__status = http_response_code();
if (is_int($__status)) echo "Status: $__status\\r\\n";
foreach (headers_list() as $__h) echo $__h, "\\r\\n";
echo "\\r\\n", $__body;`;
