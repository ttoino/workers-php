// CGI-style superglobal injection and response capture.
//
// The bundled runtime is the `embed` SAPI — no CGI wrapper — so the
// prelude synthesizes $_SERVER/$_GET/$_POST/$_COOKIE/$_FILES, and an
// ob_start callback pushes the response to JS over the bridge.

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

// PHP collapses `foo[bar][baz]` keys into nested arrays in $_POST; mirror
// that here so `name="favorites[]"` produces `$_POST['favorites'] = [...]`.

interface PhpScalarTree {
	[key: string]: string | number | (string | number)[] | PhpScalarTree;
}

const setNestedScalar = (target: PhpScalarTree, key: string, value: string): void => {
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
			if (!Array.isArray(cursor)) {
				// PHP's conversion rules: `[]` on a scalar container drops
				// the value.
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

const phpArrayFromTree = (tree: unknown): string => {
	if (typeof tree === "string") return phpQuoteString(tree);
	if (typeof tree === "number") return String(tree);
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

	const get = new Map<string, string>();
	for (const [k, v] of url.searchParams) get.set(k, v);

	// Buffer the body once: multipart parsing needs random access, and the
	// same bytes are pushed into stdin.
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
						// Group by bare name: PHP collapses `x[]`, `x[0]`,
						// `x[a]` into `$_FILES['x']['name']` arrays.
						const bareName = part.name.replace(/\[.*\]$/, "");
						if (!filesByName.has(bareName)) filesByName.set(bareName, []);
						filesByName.get(bareName)!.push(part);
						const tmpPath = `${uploadTmpDir}/workers-php-upload-${++fileCounter}`;
						stagedFiles.push({path: tmpPath, bytes: (part as {bytes: Uint8Array}).bytes});
						(part as {tmpPath?: string}).tmpPath = tmpPath;
					}
				}

				// PHP's shape: bracketed names → array metadata, bare
				// names → scalar metadata.
				for (const [bareName, group] of filesByName) {
					const bracketed = group.some((g) => g.name !== bareName);
					if (!bracketed && group.length === 1) {
						const f = group[0] as MultipartFilePartWithPath;
						filesTree[bareName] = {
							name: f.filename,
							type: f.contentType,
							tmp_name: f.tmpPath,
							error: 0,
							size: f.bytes.byteLength,
						};
					} else {
						const names: string[] = [];
						const types: string[] = [];
						const tmps: string[] = [];
						const errors: number[] = [];
						const sizes: number[] = [];
						for (const part of group) {
							const f = part as MultipartFilePartWithPath;
							names.push(f.filename);
							types.push(f.contentType);
							tmps.push(f.tmpPath);
							errors.push(0);
							sizes.push(f.bytes.byteLength);
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

	// Defensive state reset: pib_refresh should already wipe Zend state,
	// but this guards against residual $_SESSION / response code /
	// headers / ob buffers leaking from the previous request.
	return {
		phpSource: `<?php
$_SESSION = [];
@http_response_code(200);
foreach (@headers_list() as $__h) {
    $__c = strpos($__h, ':');
    if ($__c !== false) @header_remove(substr($__h, 0, $__c));
}
while (@ob_get_level() > 0) @ob_end_clean();

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

// parseMultipart parts gain `tmpPath` once staged into the wasm FS.
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
 * Installs an ob callback pushing status/headers/body to JS via the
 * bridge, rather than framing them into stdout (fragile with notice
 * output and stray whitespace).
 *
 * The embed SAPI's send_header is a no-op, so header() effects must be
 * snapshot from headers_list().
 *
 * The snapshot must leave PHP before die()/exit(): after zend_bailout,
 * pib_exec returns empty until the next pib_refresh. The ob callback
 * runs during pib_flush, ahead of bailout cleanup.
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

/** Receives the response pushed by buildCapture's ob callback. */
export interface CaptureSlot {
	value: CapturedOutput | null;
}

/**
 * A CaptureSlot plus the bridge method buildCapture's ob callback
 * writes into. Mount via setBridgeMethods; read `slot.value` after
 * pib_run returns.
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
 * @deprecated kept for back-compat with tests; use makeCaptureSlot.
 *
 * Reads $GLOBALS['__workers_php_capture'] via pib_exec, which only
 * works when the script completed normally — the snapshot is lost on
 * die()/exit().
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
 * @deprecated kept for back-compat; use buildCapture + makeCaptureSlot.
 *
 * Extracts the CGI-style header block from stdout. The embed SAPI may
 * emit its own duplicate block first, so one leading block without
 * `Status:` but with `X-Powered-By:` is skipped.
 */
export const parseOutput = (stdout: string): CapturedOutput => {
	const headers = new Headers();
	let status = 200;

	const cgiHeaderBlock = /^(?:[A-Za-z0-9!#$%&'*+\-.^_`|~]+:[^\n]*\r?\n)+\r?\n/;
	let remaining = stdout;

	const first = remaining.match(cgiHeaderBlock);
	if (!first) {
		return {body: stdout, headers, status};
	}

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
 * @deprecated kept for back-compat; alias of buildCapture(). The old
 * CGI-framing epilogue fought with notices and whitespace PHP writes
 * to stdout.
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
