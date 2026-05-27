import {describe, it, expect, beforeAll} from "vitest";
import {gzipSync} from "node:zlib";
import {createPhpHandler} from "../src/index";

// Build a minimal POSIX tar buffer in JS so the test doesn't depend on
// having `tar` on PATH inside the workers test pool.
const BLOCK = 512;
const encoder = new TextEncoder();

const writeString = (buf: Uint8Array, off: number, s: string, len: number) => {
	const bytes = encoder.encode(s);
	buf.set(bytes.subarray(0, Math.min(bytes.length, len)), off);
};

const writeOctal = (buf: Uint8Array, off: number, n: number, len: number) => {
	const s = n.toString(8).padStart(len - 1, "0") + "\0";
	writeString(buf, off, s, len);
};

const checksum = (buf: Uint8Array, off: number) => {
	for (let i = 0; i < 8; i++) buf[off + 148 + i] = 0x20;
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += buf[off + i];
	const s = sum.toString(8).padStart(6, "0") + "\0 ";
	writeString(buf, off + 148, s, 8);
};

const buildHeader = (name: string, size: number, type: string): Uint8Array => {
	const hdr = new Uint8Array(BLOCK);
	writeString(hdr, 0, name, 100);
	writeOctal(hdr, 100, 0o644, 8);
	writeOctal(hdr, 108, 0, 8);
	writeOctal(hdr, 116, 0, 8);
	writeOctal(hdr, 124, size, 12);
	writeOctal(hdr, 136, 0, 12);
	hdr[156] = type.charCodeAt(0);
	writeString(hdr, 257, "ustar", 6);
	writeString(hdr, 263, "00", 2);
	checksum(hdr, 0);
	return hdr;
};

const padBlock = (data: Uint8Array): Uint8Array => {
	const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
	if (!pad) return data;
	const out = new Uint8Array(data.length + pad);
	out.set(data);
	return out;
};

const buildTar = (
	entries: Array<{name: string; data?: string; type?: "file" | "dir"}>,
): Uint8Array => {
	const parts: Uint8Array[] = [];
	for (const e of entries) {
		const isDir = e.type === "dir";
		const bytes = isDir ? new Uint8Array(0) : encoder.encode(e.data ?? "");
		parts.push(buildHeader(e.name, bytes.length, isDir ? "5" : "0"));
		if (bytes.length) parts.push(padBlock(bytes));
	}
	parts.push(new Uint8Array(BLOCK * 2));
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
};

const makeMockAssets = (tarGz: Uint8Array): Fetcher => {
	return {
		async fetch(req: Request | string | URL): Promise<Response> {
			const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
			if (url.endsWith("/app.tar.gz")) {
				return new Response(tarGz, {status: 200});
			}
			return new Response("not found", {status: 404});
		},
	} as Fetcher;
};

describe("createPhpHandler (with mock ASSETS)", () => {
	let tarGz: Uint8Array;
	let env: {ASSETS: Fetcher};

	beforeAll(() => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"header('Content-Type: text/plain; charset=utf-8');\n" +
					"echo 'php ' . PHP_VERSION . \"\\n\";\n" +
					"echo 'q=' . ($_GET['q'] ?? '') . \"\\n\";\n" +
					"echo 'm=' . $_SERVER['REQUEST_METHOD'] . \"\\n\";\n",
			},
		]);
		// Use Node's zlib for the gzip in tests; the runtime uses
		// DecompressionStream which expects valid gzip input.
		tarGz = new Uint8Array(gzipSync(tar));
		env = {ASSETS: makeMockAssets(tarGz)};
	});

	it("returns 200 from the mounted PHP entrypoint", async () => {
		const handler = createPhpHandler({
			appRoot: "/persist/test-app",
			docroot: ".",
			entrypoint: "index.php",
		});
		const req = new Request("https://example.com/?q=hello");
		const res = await handler(req, env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("php 8.");
		expect(body).toContain("q=hello");
		expect(body).toContain("m=GET");
		expect(res.headers.get("Content-Type")).toContain("text/plain");
	}, 30000);

	it("forwards static-extension requests to ASSETS without invoking PHP", async () => {
		// Replace ASSETS with one that returns a known body for static paths.
		const trackedEnv = {
			ASSETS: {
				async fetch(req: Request | string | URL) {
					const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
					if (url.includes("/style.css")) {
						return new Response("body { color: red; }", {
							status: 200,
							headers: {"Content-Type": "text/css"},
						});
					}
					return new Response("not found", {status: 404});
				},
			} as Fetcher,
		};

		const handler = createPhpHandler({
			appRoot: "/persist/test-app-2",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(
			new Request("https://example.com/style.css"),
			trackedEnv,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("body { color: red; }");
		expect(res.headers.get("Content-Type")).toBe("text/css");
	});

	it("returns 500 with a clear message when ASSETS binding is missing", async () => {
		const handler = createPhpHandler({appRoot: "/persist/test-app-3"});
		const res = await handler(
			new Request("https://example.com/"),
			{},
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(res.status).toBe(500);
		expect(await res.text()).toMatch(/missing ASSETS binding/);
	});
});
