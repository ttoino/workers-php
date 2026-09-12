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

	it("populates $_FILES and tmp_name from a multipart upload", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"header('Content-Type: text/plain');\n" +
					"$f = $_FILES['photo'] ?? null;\n" +
					"if (!$f) { echo 'NO_FILE'; return; }\n" +
					"echo 'name=', $f['name'], \"\\n\";\n" +
					"echo 'type=', $f['type'], \"\\n\";\n" +
					"echo 'size=', $f['size'], \"\\n\";\n" +
					"echo 'tmp_exists=', file_exists($f['tmp_name']) ? '1' : '0', \"\\n\";\n" +
					"echo 'contents=', file_get_contents($f['tmp_name']), \"\\n\";\n" +
					"echo 'post_caption=', $_POST['caption'] ?? '(none)', \"\\n\";\n",
			},
		]);
		const env2 = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};

		const handler = createPhpHandler({
			appRoot: "/persist/test-files",
			docroot: ".",
			entrypoint: "index.php",
		});

		const boundary = "----WPTBoundary";
		const enc = new TextEncoder();
		const lines = [
			`--${boundary}`,
			'Content-Disposition: form-data; name="caption"',
			"",
			"a tiny test",
			`--${boundary}`,
			'Content-Disposition: form-data; name="photo"; filename="hello.txt"',
			"Content-Type: text/plain",
			"",
			"hello world\n", // body
			`--${boundary}--`,
			"",
		];
		const body = enc.encode(lines.join("\r\n"));

		const req = new Request("https://example.com/", {
			method: "POST",
			headers: {"Content-Type": `multipart/form-data; boundary=${boundary}`},
			body,
		});
		const res = await handler(req, env2, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);

		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("name=hello.txt");
		expect(text).toContain("type=text/plain");
		expect(text).toMatch(/size=1[12]/); // 11 or 12 depending on trailing newline preservation
		expect(text).toContain("tmp_exists=1");
		expect(text).toContain("contents=hello world");
		expect(text).toContain("post_caption=a tiny test");
	}, 30000);

	it("exposes raw PUT body via php://input", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"header('Content-Type: text/plain');\n" +
					"echo 'method=', $_SERVER['REQUEST_METHOD'], \"\\n\";\n" +
					"echo 'body=', file_get_contents('php://input'), \"\\n\";\n",
			},
		]);
		const env3 = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};
		const handler = createPhpHandler({
			appRoot: "/persist/test-put",
			docroot: ".",
			entrypoint: "index.php",
		});

		const req = new Request("https://example.com/api/x", {
			method: "PUT",
			headers: {"Content-Type": "application/json"},
			body: '{"hello":"world","n":42}',
		});
		const res = await handler(req, env3, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);

		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("method=PUT");
		expect(text).toContain('body={"hello":"world","n":42}');
	}, 30000);

	it("dispatches workers_php_call() into a bridge handler and round-trips JSON", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"header('Content-Type: application/json');\n" +
					"$ok    = workers_php_call('echo', ['hi', 42, ['k' => 'v']]);\n" +
					"$obj   = workers_php_call('plus', [3, 4]);\n" +
					"try { workers_php_call('boom', ['oops']); $err = 'no-throw'; }\n" +
					"catch (\\WorkersPHP\\BridgeException $e) { $err = $e->getMessage(); }\n" +
					"echo json_encode(['echoed' => $ok, 'plus' => $obj, 'err' => $err]);\n",
			},
		]);
		const envBridge = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};

		const handler = createPhpHandler({
			appRoot: "/persist/test-bridge",
			docroot: ".",
			entrypoint: "index.php",
			bridgeMethods: {
				echo: (...args: unknown[]) => ({echoed: args}),
				plus: (a: number, b: number) => a + b,
				boom: (msg: string) => {
					throw new Error("bridge:" + msg);
				},
			},
		});

		const req = new Request("https://example.com/");
		const res = await handler(req, envBridge, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			echoed: {echoed: unknown[]};
			plus: number;
			err: string;
		};
		expect(json.echoed.echoed).toEqual(["hi", 42, {k: "v"}]);
		expect(json.plus).toBe(7);
		expect(json.err).toContain("bridge:oops");
	}, 30000);

	it("captures status 302 + Location when the script die()s after header()", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"header('Location: /next');\n" +
					"die();\n",
			},
		]);
		const env4 = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};
		const handler = createPhpHandler({
			appRoot: "/persist/test-die-redir",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(
			new Request("https://example.com/"),
			env4,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/next");
	}, 30000);

	it("captures http_response_code() set before die() (pageError-style)", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"http_response_code(400);\n" +
					"echo 'bad request body';\n" +
					"die();\n",
			},
		]);
		const env5 = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};
		const handler = createPhpHandler({
			appRoot: "/persist/test-400",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(
			new Request("https://example.com/"),
			env5,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("bad request body");
	}, 30000);

	it("does NOT bleed state (headers / response code) between requests on the same handler", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"// Route 1: set custom header + status + die\n" +
					"// Route 2: just echo - must see NO trace of route 1\n" +
					"$p = $_GET['p'] ?? '';\n" +
					"if ($p === 'one') {\n" +
					"    header('X-Leak-Test: yes');\n" +
					"    http_response_code(418);\n" +
					"    echo 'one';\n" +
					"    die();\n" +
					"}\n" +
					"echo 'two-status=' . (http_response_code() ?: 200) . ';';\n" +
					"echo 'two-headers=' . count(headers_list()) . ';';\n",
			},
		]);
		const env6 = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};
		const handler = createPhpHandler({
			appRoot: "/persist/test-bleed",
			docroot: ".",
			entrypoint: "index.php",
		});

		// First request: pollute state.
		const r1 = await handler(
			new Request("https://example.com/?p=one"),
			env6,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(r1.status).toBe(418);
		expect(r1.headers.get("X-Leak-Test")).toBe("yes");
		expect(await r1.text()).toContain("one");

		// Second request: must NOT inherit anything.
		const r2 = await handler(
			new Request("https://example.com/?p=two"),
			env6,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(r2.status).toBe(200);
		expect(r2.headers.get("X-Leak-Test")).toBeNull();
		const body = await r2.text();
		expect(body).toContain("two-status=200");
		// PHP may inject Content-Type/X-Powered-By so headers_list() count varies,
		// but X-Leak-Test must not be present. We rely on the header check above.
	}, 60000);

	it("bundled wasm has mbstring, gd, openssl, intl-free extension set", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{
				name: "app/index.php",
				data:
					"<?php\n" +
					"header('Content-Type: text/plain');\n" +
					"$e = get_loaded_extensions();\n" +
					"sort($e);\n" +
					"echo implode(',', $e);\n",
			},
		]);
		const envExt = {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))};
		const handler = createPhpHandler({
			appRoot: "/persist/test-exts",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(
			new Request("https://example.com/"),
			envExt,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(res.status).toBe(200);
		const body = await res.text();
		// The README's extension list is generated from this set — keep them
		// in sync when build/php-wasm.env changes.
		for (const ext of ["mbstring", "gd", "openssl", "yaml", "fileinfo", "zip"]) {
			expect(body, `expected extension ${ext}`).toContain(ext);
		}
		expect(body).not.toContain("intl");
		expect(body).not.toContain("curl");
	}, 60000);

	it("returns 413 when the request body exceeds maxBodyBytes", async () => {
		const handler = createPhpHandler({
			appRoot: "/persist/test-large",
			docroot: ".",
			entrypoint: "index.php",
			maxBodyBytes: 16,
		});
		const req = new Request("https://example.com/", {
			method: "POST",
			body: "this body is definitely longer than sixteen bytes",
		});
		const res = await handler(req, env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);
		expect(res.status).toBe(413);
	}, 30000);
});
