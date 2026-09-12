// Minimal `multipart/form-data` body parser (RFC 7578 + RFC 2046).
//
// `request.formData()` would lose the raw bytes, which must be pushed
// into php://input, so the buffered body is parsed here instead.
//
// Scope: browser-emitted bodies (text fields, files, name="foo[]").
// Nested multiparts and content-transfer-encoding are not supported.

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
 * Returns the ordered parts; collapsing into $_POST/$_FILES (PHP's
 * `name="foo[]"` semantics) is the caller's job.
 *
 * Throws on structurally-invalid input; turn that into a 400.
 */
export const parseMultipart = (
	body: Uint8Array,
	boundary: string,
): MultipartPart[] => {
	if (!boundary) throw new Error("multipart: empty boundary");

	const enc = new TextEncoder();
	const delimiter = enc.encode(`--${boundary}`);

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

		// Preamble before the first delimiter and epilogue after the
		// closing one are ignored.
		let cursor = partStart;
		if (
			cursor + 2 <= body.length &&
			body[cursor] === 0x0d &&
			body[cursor + 1] === 0x0a
		) {
			cursor += 2;
		} else if (
			cursor + 2 <= body.length &&
			body[cursor] === 0x2d &&
			body[cursor + 1] === 0x2d
		) {
			// Closing delimiter: "--boundary--".
			break;
		} else {
			continue;
		}

		const sepIdx = findBytes(body, enc.encode("\r\n\r\n"), cursor, partEnd);
		if (sepIdx < 0) continue;

		const headerBytes = body.subarray(cursor, sepIdx);
		const headerText = new TextDecoder("utf-8").decode(headerBytes);
		const headers = parseHeaders(headerText);

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
	// Skip the leading disposition-type token (e.g. `form-data`).
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
		// RFC 5987 filename* is not decoded; browsers emit a plain
		// filename for ASCII names.
		out.set(key, value);
	}
	return out;
};
