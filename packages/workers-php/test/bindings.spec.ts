// Bindings end-to-end: PHP code uses $env->X to reach D1, R2, and KV
// instances, and the values round-trip through workers_php_call.
//
// We use simple in-process mocks for the bindings rather than the
// vitest-pool-workers real D1 because we want to verify that the
// dispatch dispatches into whatever the user provides on `env`.

import {describe, expect, it, beforeAll} from "vitest";
import {gzipSync} from "node:zlib";
import {createPhpHandler} from "../src/index";

// ---------- minimal tarball builder ----------

const BLOCK = 512;
const encoder = new TextEncoder();
const writeString = (b: Uint8Array, o: number, s: string, l: number) => {
	const x = encoder.encode(s);
	b.set(x.subarray(0, Math.min(x.length, l)), o);
};
const writeOctal = (b: Uint8Array, o: number, n: number, l: number) => {
	writeString(b, o, n.toString(8).padStart(l - 1, "0") + "\0", l);
};
const checksum = (b: Uint8Array, o: number) => {
	for (let i = 0; i < 8; i++) b[o + 148 + i] = 0x20;
	let s = 0;
	for (let i = 0; i < BLOCK; i++) s += b[o + i];
	writeString(b, o + 148, s.toString(8).padStart(6, "0") + "\0 ", 8);
};
const buildHeader = (name: string, size: number, type: string) => {
	const h = new Uint8Array(BLOCK);
	writeString(h, 0, name, 100);
	writeOctal(h, 100, 0o644, 8);
	writeOctal(h, 108, 0, 8);
	writeOctal(h, 116, 0, 8);
	writeOctal(h, 124, size, 12);
	writeOctal(h, 136, 0, 12);
	h[156] = type.charCodeAt(0);
	writeString(h, 257, "ustar", 6);
	writeString(h, 263, "00", 2);
	checksum(h, 0);
	return h;
};
const padBlock = (d: Uint8Array) => {
	const pad = (BLOCK - (d.length % BLOCK)) % BLOCK;
	if (!pad) return d;
	const o = new Uint8Array(d.length + pad);
	o.set(d);
	return o;
};
const buildTar = (entries: Array<{name: string; data?: string; type?: "file" | "dir"}>): Uint8Array => {
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

const makeMockAssets = (tarGz: Uint8Array): Fetcher =>
	({
		async fetch(req: Request | string | URL): Promise<Response> {
			const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
			if (url.endsWith("/app.tar.gz")) return new Response(tarGz, {status: 200});
			return new Response("not found", {status: 404});
		},
	}) as Fetcher;

// ---------- mock bindings ----------

interface D1MockStmt {
	bind(...values: unknown[]): D1MockStmt;
	all(): Promise<{results: Record<string, unknown>[]; success: true; meta: object}>;
	first(): Promise<Record<string, unknown> | null>;
	run(): Promise<{success: true; meta: object}>;
	raw(): Promise<unknown[][]>;
}

const makeMockD1 = (rows: Record<string, unknown>[]) => {
	let nextRowId = 100;
	const isSelectSQL = (sql: string) => /^\s*select\b/i.test(sql);
	return {
		prepare(sql: string) {
			let bound: unknown[] = [];
			const stmt: D1MockStmt = {
				bind(...v) {
					bound = v;
					return stmt;
				},
				async all() {
					return {results: [...rows], success: true, meta: {duration: 0.1, last_row_id: 0, changes: 0}};
				},
				async first() {
					return rows[0] ?? null;
				},
				async run() {
					if (isSelectSQL(sql)) {
						return {results: [...rows], success: true, meta: {duration: 0.1, last_row_id: 0, changes: 0}};
					}
					nextRowId++;
					return {results: [], success: true, meta: {duration: 0.1, last_row_id: nextRowId, changes: 1}};
				},
				async raw() {
					return rows.map((r) => Object.values(r));
				},
			};
			void bound;
			return stmt;
		},
		async batch(_stmts: D1MockStmt[]) {
			return [{results: rows, success: true, meta: {}}];
		},
		async exec(_sql: string) {
			return {count: 1, duration: 0.1};
		},
	};
};

const makeMockR2 = () => {
	const store = new Map<string, {bytes: Uint8Array; contentType?: string}>();
	return {
		async get(key: string) {
			const v = store.get(key);
			if (!v) return null;
			return {
				key,
				size: v.bytes.byteLength,
				etag: "etag-" + key,
				httpEtag: '"etag-' + key + '"',
				uploaded: new Date(0),
				httpMetadata: {contentType: v.contentType ?? "application/octet-stream"},
				customMetadata: {},
				get body() {
					return new ReadableStream({
						start(controller) {
							controller.enqueue(v.bytes);
							controller.close();
						},
					});
				},
				writeHttpMetadata(h: Headers) {
					h.set("Content-Type", v.contentType ?? "application/octet-stream");
				},
				async arrayBuffer() {
					return v.bytes.buffer.slice(v.bytes.byteOffset, v.bytes.byteOffset + v.bytes.byteLength);
				},
			};
		},
		async head(key: string) {
			const v = store.get(key);
			if (!v) return null;
			return {
				key,
				size: v.bytes.byteLength,
				etag: "etag-" + key,
				httpEtag: '"etag-' + key + '"',
				uploaded: new Date(0),
				httpMetadata: {contentType: v.contentType ?? "application/octet-stream"},
				customMetadata: {},
			};
		},
		async put(key: string, body: ArrayBuffer | Uint8Array, opts: {httpMetadata?: {contentType?: string}} = {}) {
			const u8 = body instanceof Uint8Array ? body : new Uint8Array(body);
			store.set(key, {bytes: new Uint8Array(u8), contentType: opts.httpMetadata?.contentType});
			return {
				key,
				size: u8.byteLength,
				etag: "etag-" + key,
				httpEtag: '"etag-' + key + '"',
				uploaded: new Date(0),
				httpMetadata: opts.httpMetadata ?? {},
				customMetadata: {},
			};
		},
		async delete(keys: string | string[]) {
			const list = Array.isArray(keys) ? keys : [keys];
			for (const k of list) store.delete(k);
		},
		async list() {
			return {objects: [], truncated: false};
		},
	};
};

const makeMockKV = () => {
	const store = new Map<string, string>();
	return {
		async get(key: string, _type: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list() {
			return {keys: [...store.keys()].map((name) => ({name})), list_complete: true};
		},
	};
};

// ---------- tests ----------

describe("bindings", () => {
	const phpCode = `<?php
header('Content-Type: application/json');

$out = ['ok' => true];

// D1
$row = $env->DB->prepare('SELECT * FROM Restaurant WHERE id = ?')->bind(1)->first();
$out['d1_first'] = $row;

$first = $env->DB->prepare('SELECT * FROM Restaurant WHERE id = :id')
    ->execute([':id' => 1])->first();
$out['d1_named'] = $first;

$result = $env->DB->prepare('INSERT INTO X (n) VALUES (?)')->bind('a')->run();
$out['d1_run_meta'] = (array) $result->meta;

// R2 — note "..." double quotes so PHP interprets \\x00 escapes
$env->IMAGES->put('hello.bin', "\\x00\\x01\\x02hello", ['contentType' => 'application/octet-stream']);
$obj = $env->IMAGES->get('hello.bin');
$out['r2_size'] = $obj?->size;
$out['r2_body_hex'] = $obj ? bin2hex($obj->body()) : null;
$missing = $env->IMAGES->get('not-there');
$out['r2_missing'] = $missing === null;

// KV
$env->KV->put('counter', '42');
$out['kv_get'] = $env->KV->get('counter');
$out['kv_missing'] = $env->KV->get('nope');

// var/secret
$out['app_env'] = $env->APP_ENV;

echo json_encode($out);
`;

	let tarGz: Uint8Array;

	beforeAll(() => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: phpCode},
		]);
		tarGz = new Uint8Array(gzipSync(tar));
	});

	it("exposes D1, R2, KV, and var bindings via $env", async () => {
		const env = {
			ASSETS: makeMockAssets(tarGz),
			DB: makeMockD1([
				{id: 1, name: "McDonald's", score: 4.2},
			]),
			IMAGES: makeMockR2(),
			KV: makeMockKV(),
			APP_ENV: "test",
		};

		const handler = createPhpHandler({
			appRoot: "/persist/bindings-test",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {
				DB: "d1",
				IMAGES: "r2",
				KV: "kv",
				APP_ENV: "var",
			},
		});

		const res = await handler(new Request("https://example.com/"), env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			d1_first: {id: number; name: string};
			d1_named: {id: number; name: string};
			d1_run_meta: {last_row_id: number; changes: number};
			r2_size: number;
			r2_body_hex: string;
			r2_missing: boolean;
			kv_get: string;
			kv_missing: string | null;
			app_env: string;
		};
		expect(json.d1_first.name).toBe("McDonald's");
		expect(json.d1_named.id).toBe(1);
		expect(json.d1_run_meta.last_row_id).toBeGreaterThan(0);
		expect(json.r2_size).toBe(8); // 3 binary bytes + "hello"
		expect(json.r2_body_hex).toBe("000102" + "68656c6c6f"); // \x00\x01\x02hello
		expect(json.r2_missing).toBe(true);
		expect(json.kv_get).toBe("42");
		expect(json.kv_missing).toBeNull();
		expect(json.app_env).toBe("test");
	}, 30000);

	it("exposes D1PDO as a PDO drop-in including lastInsertId and named placeholders", async () => {
		const phpPDOCode = `<?php
header('Content-Type: application/json');

$pdo = new \\WorkersPHP\\D1PDO($env->DB);
$pdo->setAttribute(\\PDO::ATTR_ERRMODE, \\PDO::ERRMODE_EXCEPTION);

// SELECT via prepare + named placeholder
$stmt = $pdo->prepare('SELECT * FROM X WHERE id = :id');
$stmt->execute([':id' => 1]);
$row = $stmt->fetch(\\PDO::FETCH_ASSOC);

// INSERT, then lastInsertId
$insert = $pdo->prepare('INSERT INTO X (n) VALUES (:n)');
$insert->execute([':n' => 'hello']);
$id = $pdo->lastInsertId();

echo json_encode(['row' => $row, 'last_id' => $id]);
`;
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: phpPDOCode},
		]);
		const env = {
			ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar))),
			DB: makeMockD1([{id: 1, n: "first-row"}]),
		};
		const handler = createPhpHandler({
			appRoot: "/persist/pdo-test",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {DB: "d1"},
		});

		const res = await handler(new Request("https://example.com/"), env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		const json = (await res.json()) as {row: {id: number; n: string}; last_id: string};
		expect(json.row.id).toBe(1);
		expect(json.row.n).toBe("first-row");
		expect(parseInt(json.last_id, 10)).toBeGreaterThan(0);
	}, 30000);

	it("staticRoutes missRewrite rewrites the path on R2 miss before ASSETS fallback", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: "<?php echo 'should not run for static';"},
		]);
		const r2 = makeMockR2();
		// Note: NOT pre-populating R2; this test only exercises the miss path.

		const env = {
			ASSETS: {
				async fetch(req: Request | string | URL) {
					const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
					if (url.endsWith("/app.tar.gz")) return new Response(gzipSync(tar), {status: 200});
					if (url.endsWith("/uploads/default.svg")) {
						return new Response("<svg/>", {
							status: 200,
							headers: {"Content-Type": "image/svg+xml"},
						});
					}
					return new Response("not found", {status: 404});
				},
			},
			IMAGES: r2,
		};

		const handler = createPhpHandler({
			appRoot: "/persist/static-rewrite",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {IMAGES: "r2"},
			staticRoutes: [{
				pathPrefix: "/uploads/",
				from: "IMAGES",
				missRewrite: (p) => p.replace(/\/[0-9]+\.webp$/, "/default.svg"),
			}],
		});

		// Request /uploads/42.webp — not in R2, gets rewritten to
		// /uploads/default.svg before ASSETS serves the placeholder.
		const res = await handler(new Request("https://example.com/uploads/42.webp"), env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(await res.text()).toBe("<svg/>");
	}, 30000);

	it("staticRoutes routes a URL prefix into an R2 bucket and falls back to ASSETS", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: "<?php echo 'should not run for static';"},
		]);
		const r2 = makeMockR2();
		await r2.put("uploads/x.bin", new Uint8Array([1, 2, 3]), {httpMetadata: {contentType: "image/jpeg"}});

		const env = {
			ASSETS: {
				async fetch(req: Request | string | URL) {
					const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
					if (url.endsWith("/app.tar.gz")) return new Response(gzipSync(tar), {status: 200});
					if (url.endsWith("/uploads/fallback.txt")) {
						return new Response("from assets", {status: 200, headers: {"Content-Type": "text/plain"}});
					}
					return new Response("not found", {status: 404});
				},
			},
			IMAGES: r2,
		};

		const handler = createPhpHandler({
			appRoot: "/persist/static-test",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {IMAGES: "r2"},
			staticRoutes: [{pathPrefix: "/uploads/", from: "IMAGES"}],
		});

		// R2 hit
		const hit = await handler(new Request("https://example.com/uploads/x.bin"), env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext);
		expect(hit.status).toBe(200);
		const bytes = new Uint8Array(await hit.arrayBuffer());
		expect(Array.from(bytes)).toEqual([1, 2, 3]);

		// R2 miss + fallback to ASSETS
		const miss = await handler(
			new Request("https://example.com/uploads/fallback.txt"),
			env,
			{waitUntil: () => {}, passThroughOnException: () => {}} as unknown as ExecutionContext,
		);
		expect(miss.status).toBe(200);
		expect(await miss.text()).toBe("from assets");
	}, 30000);
});

// ----------------------------------------------------------------------
// Session handlers
// ----------------------------------------------------------------------

/** Build a minimal in-process D1 that handles just enough SQL for the
 *  workers-php session handler: CREATE TABLE IF NOT EXISTS, INSERT … ON
 *  CONFLICT UPDATE, SELECT … WHERE id = ? AND expires > ?, DELETE … */
const makeSessionD1 = () => {
	type Row = {id: string; data: string; expires: number};
	const store = new Map<string, Row>();
	let tableCreated = false;

	const matchSelect = (sql: string) =>
		/^SELECT\s+(?:data|1\s+AS\s+x)\s+FROM\s+"([^"]+)"\s+WHERE\s+id\s*=\s*\?\s+AND\s+expires\s*>\s*\?/i
			.test(sql);
	const matchUpsert = (sql: string) =>
		/^INSERT\s+INTO\s+"([^"]+)"\s*\(id,\s*data,\s*expires\)\s+VALUES\s*\(\?\s*,\s*\?\s*,\s*\?\s*\)\s+ON\s+CONFLICT\(id\)\s+DO\s+UPDATE/i
			.test(sql);
	const matchDelete = (sql: string) =>
		/^DELETE\s+FROM\s+"([^"]+)"\s+WHERE\s+id\s*=\s*\?/i.test(sql);
	const matchGc = (sql: string) =>
		/^DELETE\s+FROM\s+"([^"]+)"\s+WHERE\s+expires\s*<\s*\?/i.test(sql);

	return {
		_store: store,
		prepare(sql: string) {
			let bound: unknown[] = [];
			const stmt = {
				bind(...v: unknown[]) {
					bound = v;
					return stmt;
				},
				async all() {
					if (matchSelect(sql)) {
						const [id, now] = bound as [string, number];
						const row = store.get(id);
						const ok = row && row.expires > now;
						return {results: ok ? [row] : [], success: true, meta: {}};
					}
					return {results: [], success: true, meta: {}};
				},
				async first() {
					if (matchSelect(sql)) {
						const [id, now] = bound as [string, number];
						const row = store.get(id);
						const ok = row && row.expires > now;
						return ok ? {data: row.data, x: 1} : null;
					}
					return null;
				},
				async run() {
					if (matchUpsert(sql)) {
						const [id, data, expires] = bound as [string, string, number];
						store.set(id, {id, data, expires});
						return {results: [], success: true, meta: {changes: 1}};
					}
					if (matchDelete(sql)) {
						const [id] = bound as [string];
						const had = store.delete(id);
						return {results: [], success: true, meta: {changes: had ? 1 : 0}};
					}
					if (matchGc(sql)) {
						const [now] = bound as [number];
						let n = 0;
						for (const [k, v] of store) {
							if (v.expires < now) {
								store.delete(k);
								n++;
							}
						}
						return {results: [], success: true, meta: {changes: n}};
					}
					return {results: [], success: true, meta: {changes: 0}};
				},
				async raw() {
					return [];
				},
			};
			return stmt;
		},
		async batch(_stmts: unknown[]) {
			return [];
		},
		async exec(sql: string) {
			if (/CREATE TABLE IF NOT EXISTS/i.test(sql)) {
				tableCreated = true;
			}
			void tableCreated;
			return {count: 1, duration: 0};
		},
	};
};

describe("session handlers", () => {
	const sessionPhp = `<?php
header('Content-Type: application/json');

session_start();
$out = ['session_id' => session_id()];
if (isset($_GET['set'])) {
    $_SESSION['greeting'] = $_GET['set'];
    $out['set'] = $_SESSION['greeting'];
} else {
    $out['read'] = $_SESSION['greeting'] ?? '(missing)';
}
echo json_encode($out);
`;

	const newCtx = () => ({
		waitUntil: () => {},
		passThroughOnException: () => {},
	}) as unknown as ExecutionContext;

	it("D1 sessions round-trip across two requests with the same cookie", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: sessionPhp},
		]);
		const env = {
			ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar))),
			DB: makeSessionD1(),
		};
		const handler = createPhpHandler({
			appRoot: "/persist/sessions-d1",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {DB: "d1"},
			sessionHandler: {backend: "d1", from: "DB", strictMode: false},
		});

		// Request 1: set $_SESSION['greeting'] = 'hello'.
		const res1 = await handler(
			new Request("https://example.com/?set=hello"),
			env,
			newCtx(),
		);
		expect(res1.status).toBe(200);
		const setCookie = res1.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(/PHPSESSID=[a-zA-Z0-9]+/);
		const sid = setCookie.match(/PHPSESSID=([a-zA-Z0-9]+)/)?.[1] ?? "";
		const body1 = (await res1.json()) as {session_id: string; set: string};
		expect(body1.set).toBe("hello");
		expect(body1.session_id).toBe(sid);

		// Verify D1 has the session row.
		const row = env.DB._store.get(sid);
		expect(row).toBeDefined();
		expect(row!.data).toContain("greeting");
		expect(row!.data).toContain("hello");

		// Request 2: read $_SESSION['greeting'] back via the same cookie.
		const res2 = await handler(
			new Request("https://example.com/", {
				headers: {cookie: `PHPSESSID=${sid}`},
			}),
			env,
			newCtx(),
		);
		expect(res2.status).toBe(200);
		const body2 = (await res2.json()) as {session_id: string; read: string};
		expect(body2.session_id).toBe(sid);
		expect(body2.read).toBe("hello");
	}, 30000);

	it("KV sessions round-trip across two requests with the same cookie", async () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: sessionPhp},
		]);
		const env = {
			ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar))),
			KV: makeMockKV(),
		};
		const handler = createPhpHandler({
			appRoot: "/persist/sessions-kv",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {KV: "kv"},
			sessionHandler: {backend: "kv", from: "KV", strictMode: false},
		});

		const res1 = await handler(
			new Request("https://example.com/?set=world"),
			env,
			newCtx(),
		);
		expect(res1.status).toBe(200);
		const setCookie = res1.headers.get("set-cookie") ?? "";
		const sid = setCookie.match(/PHPSESSID=([a-zA-Z0-9]+)/)?.[1] ?? "";
		expect(sid).not.toBe("");

		const res2 = await handler(
			new Request("https://example.com/", {
				headers: {cookie: `PHPSESSID=${sid}`},
			}),
			env,
			newCtx(),
		);
		const body2 = (await res2.json()) as {read: string};
		expect(body2.read).toBe("world");
	}, 30000);

	it("expired sessions read as empty (ttlSeconds=0 effectively expires immediately)", async () => {
		const expirePhp = `<?php
header('Content-Type: text/plain');
session_start();
echo isset($_SESSION['greeting']) ? "found:" . $_SESSION['greeting'] : "(empty)";
$_SESSION['greeting'] = 'should-not-persist';
`;
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/index.php", data: expirePhp},
		]);
		const env = {
			ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar))),
			DB: makeSessionD1(),
		};
		const handler = createPhpHandler({
			appRoot: "/persist/sessions-expire",
			docroot: ".",
			entrypoint: "index.php",
			bindings: {DB: "d1"},
			sessionHandler: {backend: "d1", from: "DB", ttlSeconds: 0, strictMode: false},
		});

		// Request 1: writes session with ttl=0 (expires "now").
		const res1 = await handler(new Request("https://example.com/"), env, newCtx());
		const setCookie = res1.headers.get("set-cookie") ?? "";
		const sid = setCookie.match(/PHPSESSID=([a-zA-Z0-9]+)/)?.[1] ?? "";
		expect(await res1.text()).toBe("(empty)");

		// Request 2: row exists but expires (which equals "now") is no
		// longer "> now", so read() returns empty.
		const res2 = await handler(
			new Request("https://example.com/", {
				headers: {cookie: `PHPSESSID=${sid}`},
			}),
			env,
			newCtx(),
		);
		// session may have generated a new id (because the old row is
		// effectively expired) — either way, no greeting should leak.
		expect(await res2.text()).toBe("(empty)");
	}, 30000);
});
