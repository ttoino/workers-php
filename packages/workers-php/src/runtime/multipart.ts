// Minimal `multipart/form-data` body parser (RFC 7578 + RFC 2046).
//
// Workers' Request supports `request.formData()`, but it consumes the body
// and loses the raw bytes — we need those bytes (to push into php://input
// stdin) AND structured access to file parts (to populate $_FILES and write
// temp files into the wasm FS). So we parse the buffered body ourselves.
//
// Scope: enough to handle browser-emitted multipart bodies for the common
// cases (text fields, single files, name="foo[]" multi-file). NOT a
// general-purpose MIME parser — chained encodings, nested multiparts, and
// content-transfer-encoding: base64/quoted-printable are not supported.

export interface MultipartTextPart {
	kind: "text";
	name: string;
	value: string;
}

export interface MultipartFilePart {
	kind: "file";
	name: string;
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

export type MultipartPart = MultipartTextPart | MultipartFilePart;

/**
 * Parse a `multipart/form-data` body. Returns the ordered list of parts;
 * the caller is responsible for collapsing into $_POST/$_FILES arrays
 * (PHP semantics for `name="foo[]"` etc. are layered on top).
 *
 * Throws on structurally-invalid input. The caller should turn that into
 * a 400 response.
 */
export const parseMultipart = (
	body: Uint8Array,
	boundary: string,
): MultipartPart[] => {
	if (!boundary) throw new Error("multipart: empty boundary");

	const enc = new TextEncoder();
	const delimiter = enc.encode(`--${boundary}`);
	const crlf = enc.encode("\r\n");

	// Find each delimiter occurrence; parts are the bytes between them.
	const positions: number[] = [];
	let i = 0;
	while (i <= body.length - delimiter.length) {
		if (bytesEqualAt(body, i, delimiter)) {
			positions.push(i);
			i += delimiter.length;
		} else {
			i++;
		}
	}
	if (positions.length < 2) {
		throw new Error("multipart: no delimiters found in body");
	}

	const parts: MultipartPart[] = [];

	for (let p = 0; p < positions.length - 1; p++) {
		const partStart = positions[p] + delimiter.length;
		const partEnd = positions[p + 1];

		// Each part is preceded by a CRLF after the delimiter; the last
		// delimiter is followed by `--` (closing). Detect closing.
		// We skip the "preamble" before the first delimiter and the
		// "epilogue" after the closing delimiter.

		// First scan: skip a possible CRLF after the delimiter on this part.
		let cursor = partStart;
		if (
			cursor + 2 <= body.length &&
			body[cursor] === 0x0d &&
			body[cursor + 1] === 0x0a
		) {
			cursor += 2;
		} else if (
			cursor + 2 <= body.length &&
			body[cursor] === 0x2d && // '-'
			body[cursor + 1] === 0x2d // '-'
		) {
			// Closing delimiter ("--boundary--"). No more parts.
			break;
		} else {
			// Malformed; skip this part.
			continue;
		}

		// Find headers/body separator: CRLF CRLF
		const sepIdx = findBytes(body, enc.encode("\r\n\r\n"), cursor, partEnd);
		if (sepIdx < 0) continue;

		const headerBytes = body.subarray(cursor, sepIdx);
		const headerText = new TextDecoder("utf-8").decode(headerBytes);
		const headers = parseHeaders(headerText);

		// Trim the trailing CRLF that precedes the next delimiter.
		let bodyStart = sepIdx + 4;
		let bodyEnd = partEnd;
		if (
			bodyEnd >= bodyStart + 2 &&
			body[bodyEnd - 2] === 0x0d &&
			body[bodyEnd - 1] === 0x0a
		) {
			bodyEnd -= 2;
		}

		const disp = headers.get("content-disposition");
		if (!disp) continue;
		const params = parseHeaderParams(disp);
		const name = params.get("name");
		if (!name) continue;

		const filename = params.get("filename");
		const partBody = body.subarray(bodyStart, bodyEnd);

		if (filename !== undefined) {
			parts.push({
				kind: "file",
				name,
				filename,
				contentType: headers.get("content-type") ?? "application/octet-stream",
				bytes: new Uint8Array(partBody),
			});
		} else {
			const value = new TextDecoder("utf-8").decode(partBody);
			parts.push({kind: "text", name, value});
		}

		// crlf var used to satisfy import noise; reference it explicitly:
		void crlf;
	}

	return parts;
};

/** Extract `boundary=` from a Content-Type header value. Returns the
 *  boundary string without quotes, or `null` if absent / malformed. */
export const boundaryFromContentType = (ct: string | null): string | null => {
	if (!ct) return null;
	const match = ct.match(/boundary=("([^"]+)"|([^;,\s]+))/i);
	if (!match) return null;
	return match[2] ?? match[3] ?? null;
};

// ---------- helpers ----------

const bytesEqualAt = (
	haystack: Uint8Array,
	offset: number,
	needle: Uint8Array,
): boolean => {
	if (offset + needle.length > haystack.length) return false;
	for (let i = 0; i < needle.length; i++) {
		if (haystack[offset + i] !== needle[i]) return false;
	}
	return true;
};

const findBytes = (
	haystack: Uint8Array,
	needle: Uint8Array,
	start: number,
	end: number,
): number => {
	const limit = end - needle.length;
	for (let i = start; i <= limit; i++) {
		if (bytesEqualAt(haystack, i, needle)) return i;
	}
	return -1;
};

const parseHeaders = (text: string): Map<string, string> => {
	const out = new Map<string, string>();
	for (const rawLine of text.split(/\r?\n/)) {
		if (!rawLine) continue;
		const idx = rawLine.indexOf(":");
		if (idx <= 0) continue;
		const key = rawLine.slice(0, idx).trim().toLowerCase();
		const value = rawLine.slice(idx + 1).trim();
		out.set(key, value);
	}
	return out;
};

/** Parse `Content-Disposition: form-data; name="x"; filename="y.png"` etc. */
const parseHeaderParams = (header: string): Map<string, string> => {
	const out = new Map<string, string>();
	// Skip the leading "form-data" or whatever the type token is.
	const semi = header.indexOf(";");
	if (semi < 0) return out;
	const rest = header.slice(semi + 1);
	// Greedy: handle quoted values with possible escaped quotes (`\"`).
	const re = /\s*([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))\s*(?:;|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rest)) !== null) {
		const key = m[1].toLowerCase();
		let value: string;
		if (m[2] !== undefined) {
			value = m[2].replace(/\\(.)/g, "$1");
		} else {
			value = (m[3] ?? "").trim();
		}
		// RFC 5987-encoded filename* takes precedence if present, but most
		// browsers emit a plain filename="..." for ASCII names. Skip the
		// fancy decoding for now.
		out.set(key, value);
	}
	return out;
};
