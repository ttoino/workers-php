// Binding dispatch table. Returns the `Module.workersPhpBridge` methods
// implementing D1 / R2 / KV operations for a given (env, bindings)
// pair. Called per-request from createPhpHandler so each method closes
// over the correct env binding.

import type {BindingDeclarations} from "./handler";
import type {BridgeMethods} from "./bridge";

/**
 * Per-isolate cache of `<binding>:<table>` pairs already ensured via
 * `CREATE TABLE IF NOT EXISTS`, so session schema setup doesn't cost a
 * D1 round-trip on every request.
 */
const ensuredSessionTables = new Set<string>();

// Duck-typed instead of importing D1Database/R2Bucket/KVNamespace, so
// the library compiles without workers-types in the consuming project.
interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	all(): Promise<{results: unknown[]; success: boolean; meta?: unknown}>;
	first(): Promise<unknown>;
	run(): Promise<{results?: unknown[]; success: boolean; meta?: unknown}>;
	raw(): Promise<unknown[][]>;
}
interface D1Database {
	prepare(sql: string): D1PreparedStatement;
	batch(stmts: D1PreparedStatement[]): Promise<unknown[]>;
	exec(sql: string): Promise<{count: number; duration: number}>;
}
interface R2Bucket {
	get(key: string): Promise<R2ObjectBody | null>;
	head(key: string): Promise<R2Object | null>;
	put(key: string, body: ArrayBuffer | Uint8Array, opts?: object): Promise<R2Object>;
	delete(keys: string | string[]): Promise<void>;
	list(opts?: object): Promise<{objects: R2Object[]; truncated: boolean; cursor?: string}>;
}
interface R2Object {
	key: string;
	size: number;
	etag: string;
	httpEtag: string;
	uploaded: Date;
	httpMetadata?: {contentType?: string};
	customMetadata?: Record<string, string>;
}
interface R2ObjectBody extends R2Object {
	arrayBuffer(): Promise<ArrayBuffer>;
}
interface KVNamespace {
	get(key: string, type?: "text" | "json" | "arrayBuffer"): Promise<string | unknown | ArrayBuffer | null>;
	put(key: string, value: string, opts?: object): Promise<void>;
	delete(key: string): Promise<void>;
	list(opts?: object): Promise<{keys: Array<{name: string; expiration?: number; metadata?: unknown}>; list_complete: boolean; cursor?: string}>;
}

const bytesToBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < u8.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
	}
	return btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};

const r2ObjectToJSON = (o: R2Object): Record<string, unknown> => ({
	key: o.key,
	size: o.size,
	etag: o.etag,
	httpEtag: o.httpEtag,
	uploaded: o.uploaded ? o.uploaded.toISOString() : null,
	contentType: o.httpMetadata?.contentType ?? null,
	customMetadata: o.customMetadata ?? {},
});

/**
 * Build the dispatch methods plugged into `Module.workersPhpBridge` for a
 * given request's `env`. Methods are named to match what the PHP-side
 * binding classes call via `workers_php_call($method, $args)`.
 */
export const makeBindingDispatch = (
	env: unknown,
	bindings: BindingDeclarations,
): BridgeMethods => {
	const envMap = (env ?? {}) as Record<string, unknown>;
	const out: BridgeMethods = {};

	const d1 = (name: string): D1Database => {
		const b = envMap[name] as D1Database | undefined;
		if (!b || typeof b.prepare !== "function") {
			throw new Error(`workers-php: D1 binding '${name}' is missing or wrong type on env`);
		}
		return b;
	};
	const r2 = (name: string): R2Bucket => {
		const b = envMap[name] as R2Bucket | undefined;
		if (!b || typeof b.get !== "function") {
			throw new Error(`workers-php: R2 binding '${name}' is missing or wrong type on env`);
		}
		return b;
	};
	const kv = (name: string): KVNamespace => {
		const b = envMap[name] as KVNamespace | undefined;
		if (!b || typeof b.get !== "function") {
			throw new Error(`workers-php: KV binding '${name}' is missing or wrong type on env`);
		}
		return b;
	};

	// Register methods only for declared kinds, so undeclared bindings on
	// env stay unreachable from PHP.
	const kinds = new Set(Object.values(bindings));

	if (kinds.has("d1")) {
		const buildStmt = (binding: string, sql: string, params: unknown[]) => {
			let s = d1(binding).prepare(sql);
			if (params.length) s = s.bind(...params);
			return s;
		};
		out.d1_all = async (binding: string, sql: string, params: unknown[]) => {
			const r = await buildStmt(binding, sql, params).all();
			return {results: r.results, success: r.success, meta: r.meta ?? {}};
		};
		out.d1_first = async (binding: string, sql: string, params: unknown[], col: string | null) => {
			const stmt = buildStmt(binding, sql, params);
			if (col) {
				const row = await stmt.first();
				if (!row) return null;
				return (row as Record<string, unknown>)[col] ?? null;
			}
			return await stmt.first();
		};
		out.d1_run = async (binding: string, sql: string, params: unknown[]) => {
			// D1's `.run()` returns `results` for SELECTs too; preserve it
			// so `prepare(...)->execute()->fetch()` keeps working.
			const r = (await buildStmt(binding, sql, params).run()) as {
				results?: unknown[];
				success: boolean;
				meta?: unknown;
			};
			return {results: r.results ?? [], success: r.success, meta: r.meta ?? {}};
		};
		out.d1_raw = async (binding: string, sql: string, params: unknown[]) => {
			return await buildStmt(binding, sql, params).raw();
		};
		out.d1_exec = async (binding: string, sql: string) => {
			return await d1(binding).exec(sql);
		};
		/** First-use session schema; cached per isolate, idempotent via
		 *  `IF NOT EXISTS`. */
		out.d1_ensure_sessions_table = async (binding: string, table: string) => {
			const cacheKey = `${binding}:${table}`;
			if (ensuredSessionTables.has(cacheKey)) return null;
			// Two calls: exec() runs a single statement at a time on some
			// D1 versions.
			await d1(binding).exec(
				`CREATE TABLE IF NOT EXISTS "${table}" (` +
				` id TEXT PRIMARY KEY,` +
				` data BLOB NOT NULL,` +
				` expires INTEGER NOT NULL` +
				`)`,
			);
			await d1(binding).exec(
				`CREATE INDEX IF NOT EXISTS "idx_${table}_expires" ON "${table}"(expires)`,
			);
			ensuredSessionTables.add(cacheKey);
			return null;
		};
		out.d1_batch = async (binding: string, statements: Array<{sql: string; params: unknown[]}>) => {
			const stmts = statements.map((s) => {
				let st = d1(binding).prepare(s.sql);
				if (s.params.length) st = st.bind(...s.params);
				return st;
			});
			const raw = await d1(binding).batch(stmts);
			return raw.map((r) => {
				const rr = r as {results?: unknown[]; success?: boolean; meta?: unknown};
				return {results: rr.results ?? [], success: rr.success ?? true, meta: rr.meta ?? {}};
			});
		};
	}

	if (kinds.has("r2")) {
		out.r2_get = async (binding: string, key: string) => {
			const obj = await r2(binding).get(key);
			if (!obj) return null;
			const buf = await obj.arrayBuffer();
			return {
				...r2ObjectToJSON(obj),
				bodyB64: bytesToBase64(buf),
			};
		};
		out.r2_head = async (binding: string, key: string) => {
			const obj = await r2(binding).head(key);
			return obj ? r2ObjectToJSON(obj) : null;
		};
		out.r2_put = async (binding: string, key: string, bodyB64: string, opts: {contentType?: string; customMetadata?: Record<string, string>}) => {
			const bytes = base64ToBytes(bodyB64);
			const r2Opts: {httpMetadata?: {contentType: string}; customMetadata?: Record<string, string>} = {};
			if (opts?.contentType) r2Opts.httpMetadata = {contentType: opts.contentType};
			if (opts?.customMetadata) r2Opts.customMetadata = opts.customMetadata;
			const obj = await r2(binding).put(key, bytes, r2Opts);
			return r2ObjectToJSON(obj);
		};
		out.r2_delete = async (binding: string, keys: string | string[]) => {
			await r2(binding).delete(keys);
			return null;
		};
		out.r2_list = async (binding: string, opts: object) => {
			const r = await r2(binding).list(opts);
			return {
				objects: r.objects.map(r2ObjectToJSON),
				truncated: r.truncated,
				cursor: r.cursor ?? null,
			};
		};
	}

	if (kinds.has("kv")) {
		out.kv_get = async (binding: string, key: string, type: string) => {
			const t = (type === "json" || type === "arrayBuffer") ? type : "text";
			const v = await kv(binding).get(key, t as "text" | "json" | "arrayBuffer");
			if (v === null || v === undefined) return null;
			if (t === "arrayBuffer") {
				return bytesToBase64(v as ArrayBuffer);
			}
			return v;
		};
		out.kv_put = async (binding: string, key: string, value: string, opts: object) => {
			await kv(binding).put(key, value, opts);
			return null;
		};
		out.kv_delete = async (binding: string, key: string) => {
			await kv(binding).delete(key);
			return null;
		};
		out.kv_list = async (binding: string, opts: object) => {
			return await kv(binding).list(opts);
		};
	}

	// Outbound HTTP backing the curl_* polyfill. Uses the global fetch(),
	// so no binding declaration is needed. Bodies cross the bridge
	// base64-encoded; fetch()'s TypeError on network failure surfaces as
	// \WorkersPHP\BridgeException → CURLE_COULDNT_CONNECT in the polyfill.
	out.http_fetch = async (
		url: string,
		opts: {
			method?: string;
			headers?: Record<string, string>;
			bodyB64?: string | null;
			redirect?: "follow" | "manual";
			timeoutSeconds?: number;
		},
	) => {
		const init: RequestInit = {
			method: opts.method ?? "GET",
			redirect: opts.redirect === "manual" ? "manual" : "follow",
		};
		if (opts.headers && Object.keys(opts.headers).length > 0) {
			init.headers = opts.headers;
		}
		if (opts.bodyB64) {
			init.body = base64ToBytes(opts.bodyB64);
		}
		if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
			init.signal = AbortSignal.timeout(opts.timeoutSeconds * 1000);
		}
		const res = await fetch(url, init);
		const headers: Record<string, string> = {};
		res.headers.forEach((value, key) => {
			headers[key] = value;
		});
		return {
			status: res.status,
			url: res.url,
			headers,
			bodyB64: bytesToBase64(await res.arrayBuffer()),
		};
	};

	return out;
};

/**
 * Build the PHP literal that initialises `$env`. `var`/`secret` values
 * are inlined from the JS-side env; other kinds become {type, binding}
 * shapes that `\WorkersPHP\Env` instantiates lazily.
 */
export const buildEnvDeclaration = (
	env: unknown,
	bindings: BindingDeclarations,
): string => {
	const envMap = (env ?? {}) as Record<string, unknown>;
	const phpQuote = (s: string): string =>
		"'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
	const parts: string[] = [];
	for (const [name, kind] of Object.entries(bindings)) {
		if (kind === "var" || kind === "secret") {
			const value = envMap[name];
			const valueLit = value === undefined || value === null
				? "null"
				: phpQuote(String(value));
			parts.push(`${phpQuote(name)} => ['type' => ${phpQuote(kind)}, 'value' => ${valueLit}]`);
		} else {
			parts.push(`${phpQuote(name)} => ['type' => ${phpQuote(kind)}, 'binding' => ${phpQuote(name)}]`);
		}
	}
	return `$env = new \\WorkersPHP\\Env([${parts.join(", ")}]);\n`;
};

/**
 * Configuration accepted by `buildSessionDeclaration`. Identical shape to
 * the `SessionHandlerConfig` exported from handler.ts — duplicated here
 * to avoid a circular import.
 */
export interface SessionDeclarationConfig {
	backend: "d1" | "kv";
	from: string;
	table?: string;
	keyPrefix?: string;
	ttlSeconds?: number;
	strictMode?: boolean;
}

/**
 * Build the PHP source that registers the session save handler. Emitted
 * by `buildPrelude` after `$env`; runs before any user-side
 * `session_start()`.
 */
export const buildSessionDeclaration = (
	bindings: BindingDeclarations,
	cfg: SessionDeclarationConfig,
): string => {
	const phpQuote = (s: string): string =>
		"'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

	const kind = bindings[cfg.from];
	if (!kind) {
		throw new Error(
			`workers-php: sessionHandler.from='${cfg.from}' does not match any declared binding`,
		);
	}
	if (cfg.backend === "d1" && kind !== "d1") {
		throw new Error(
			`workers-php: sessionHandler.backend='d1' requires bindings['${cfg.from}']='d1' (got '${kind}')`,
		);
	}
	if (cfg.backend === "kv" && kind !== "kv") {
		throw new Error(
			`workers-php: sessionHandler.backend='kv' requires bindings['${cfg.from}']='kv' (got '${kind}')`,
		);
	}

	const ttl = cfg.ttlSeconds ?? 86400;
	const strictMode = cfg.strictMode ?? true;
	const strictLine = strictMode
		? `ini_set('session.use_strict_mode', '1');\n`
		: "";

	if (cfg.backend === "d1") {
		const table = cfg.table ?? "workers_php_sessions";
		return (
			`workers_php_call('d1_ensure_sessions_table', [${phpQuote(cfg.from)}, ${phpQuote(table)}]);\n` +
			`$__sessionHandler = new \\WorkersPHP\\SessionHandlerD1($env->${cfg.from}, ${phpQuote(table)}, ${ttl});\n` +
			`session_set_save_handler($__sessionHandler, true);\n` +
			strictLine
		);
	}
	const prefix = cfg.keyPrefix ?? "sess:";
	return (
		`$__sessionHandler = new \\WorkersPHP\\SessionHandlerKV($env->${cfg.from}, ${phpQuote(prefix)}, ${ttl});\n` +
		`session_set_save_handler($__sessionHandler, true);\n` +
		strictLine
	);
};
