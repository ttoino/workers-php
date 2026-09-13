// Shared test helpers: minimal POSIX tar builder + mock ASSETS fetcher.
// handler.spec.ts predates this file and keeps its own copies.

import {gzipSync} from "node:zlib";

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

export const buildTar = (
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

export const makeMockAssets = (tarGz: Uint8Array): Fetcher => {
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

/** Build a handler-ready app: tar with a single index.php, gzipped, plus
 *  the matching mock ASSETS env. */
export const makePhpApp = (indexPhp: string): {env: {ASSETS: Fetcher}} => {
	const tar = buildTar([
		{name: "app/", type: "dir"},
		{name: "app/index.php", data: indexPhp},
	]);
	return {env: {ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar)))}};
};

export const mockCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** In-process D1 emulation with page_hits semantics for the framework
 *  example smoke specs: INSERT rows land, `COUNT(*) AS aggregate`
 *  reflects them; everything else runs for real. */
export const makePageHitsD1 = () => {
	const rows: {id: number; path: string; created_at: string}[] = [];
	const resultsFor = (sql: string) =>
		/count\(\*\)\s+as\s+"?aggregate"?/i.test(sql)
			? [{aggregate: rows.length}]
			: rows.map((r) => ({...r}));
	const stmt = (sql: string, params: unknown[]) => ({
		async run() {
			// The PDO path (lib.php D1PDOStatement) routes every statement
			// through d1_run, so branch on the SQL shape here.
			if (/^\s*insert/i.test(sql)) {
				rows.push({
					id: rows.length + 1,
					path: String(params[0] ?? ""),
					created_at: "",
				});
				return {
					results: [],
					success: true,
					meta: {duration: 0.1, last_row_id: rows.length, changes: 1},
				};
			}
			return {
				results: resultsFor(sql),
				success: true,
				meta: {duration: 0.1, last_row_id: 0, changes: 0},
			};
		},
		async all() {
			return this.run();
		},
		async first(colName?: string | null) {
			const results = /^\s*insert/i.test(sql) ? [] : resultsFor(sql);
			const row = (results[0] ?? null) as Record<string, unknown> | null;
			return colName ? (row?.[colName] ?? null) : row;
		},
		async raw() {
			return rows.map((r) => Object.values(r));
		},
	});
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return stmt(sql, params);
				},
				...stmt(sql, []),
			};
		},
		async batch() {
			return [];
		},
		async exec() {
			return {count: 0, duration: 0};
		},
	};
};

/** Parse the shared "Page hits: <strong>N</strong>" counter page served
 *  by the framework examples. */
export const hitCount = (html: string): number => {
	const m = html.match(/Page hits[\s\S]*?<strong>(\d+)<\/strong>/);
	if (!m) throw new Error("hit counter not found in response");
	return Number(m[1]);
};
