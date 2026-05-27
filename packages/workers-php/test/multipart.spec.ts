import {describe, expect, it} from "vitest";
import {boundaryFromContentType, parseMultipart} from "../src/runtime/multipart";

const enc = new TextEncoder();

/** Build a multipart body from a list of parts and a chosen boundary. */
const buildBody = (
	boundary: string,
	parts: Array<
		| {name: string; value: string}
		| {name: string; filename: string; contentType: string; bytes: Uint8Array}
	>,
): Uint8Array => {
	const chunks: Uint8Array[] = [];
	for (const p of parts) {
		chunks.push(enc.encode(`--${boundary}\r\n`));
		if ("filename" in p) {
			chunks.push(
				enc.encode(
					`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
						`Content-Type: ${p.contentType}\r\n\r\n`,
				),
			);
			chunks.push(p.bytes);
			chunks.push(enc.encode("\r\n"));
		} else {
			chunks.push(enc.encode(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
			chunks.push(enc.encode(p.value));
			chunks.push(enc.encode("\r\n"));
		}
	}
	chunks.push(enc.encode(`--${boundary}--\r\n`));
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out;
};

describe("parseMultipart", () => {
	it("parses plain text fields", () => {
		const body = buildBody("xyz", [
			{name: "a", value: "hello"},
			{name: "b", value: "world"},
		]);
		const parts = parseMultipart(body, "xyz");
		expect(parts).toHaveLength(2);
		expect(parts[0]).toEqual({kind: "text", name: "a", value: "hello"});
		expect(parts[1]).toEqual({kind: "text", name: "b", value: "world"});
	});

	it("parses a single binary file part", () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 255, 254, 253]);
		const body = buildBody("zzz", [
			{name: "upload", filename: "x.bin", contentType: "application/octet-stream", bytes},
		]);
		const parts = parseMultipart(body, "zzz");
		expect(parts).toHaveLength(1);
		const f = parts[0];
		expect(f.kind).toBe("file");
		if (f.kind !== "file") return;
		expect(f.filename).toBe("x.bin");
		expect(f.contentType).toBe("application/octet-stream");
		expect(Array.from(f.bytes)).toEqual([0, 1, 2, 3, 255, 254, 253]);
	});

	it("handles mixed text and file parts", () => {
		const body = buildBody("b", [
			{name: "title", value: "hello"},
			{name: "file", filename: "a.txt", contentType: "text/plain", bytes: enc.encode("contents")},
			{name: "ok", value: "1"},
		]);
		const parts = parseMultipart(body, "b");
		expect(parts.map((p) => p.kind)).toEqual(["text", "file", "text"]);
	});

	it("ignores parts without a Content-Disposition", () => {
		const boundary = "b";
		const malformed = enc.encode(
			`--${boundary}\r\n` +
				`Content-Type: text/plain\r\n\r\n` +
				`orphan\r\n` +
				`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="ok"\r\n\r\n` +
				`yes\r\n` +
				`--${boundary}--\r\n`,
		);
		const parts = parseMultipart(malformed, boundary);
		expect(parts).toHaveLength(1);
		expect(parts[0]).toEqual({kind: "text", name: "ok", value: "yes"});
	});

	it("supports name=\"foo[]\" multi-file inputs", () => {
		const body = buildBody("b", [
			{name: "files[]", filename: "a.txt", contentType: "text/plain", bytes: enc.encode("aa")},
			{name: "files[]", filename: "b.txt", contentType: "text/plain", bytes: enc.encode("bb")},
		]);
		const parts = parseMultipart(body, "b");
		expect(parts).toHaveLength(2);
		expect(parts[0].name).toBe("files[]");
		expect(parts[1].name).toBe("files[]");
	});

	it("throws when no delimiters are present", () => {
		expect(() => parseMultipart(enc.encode("not multipart"), "anything")).toThrow();
	});
});

describe("boundaryFromContentType", () => {
	it("extracts an unquoted boundary", () => {
		expect(boundaryFromContentType("multipart/form-data; boundary=abc123")).toBe("abc123");
	});

	it("extracts a quoted boundary", () => {
		expect(boundaryFromContentType('multipart/form-data; boundary="abc 123"')).toBe("abc 123");
	});

	it("returns null when missing", () => {
		expect(boundaryFromContentType("multipart/form-data")).toBeNull();
	});

	it("returns null for null input", () => {
		expect(boundaryFromContentType(null)).toBeNull();
	});

	it("handles boundary= followed by other parameters", () => {
		expect(boundaryFromContentType("multipart/form-data; charset=utf-8; boundary=xx; extra=1")).toBe("xx");
	});
});
