// Mount an ASSETS-backed `app.tar.gz` into the PHP wasm filesystem on the
// first request, idempotent and cached for the isolate's lifetime.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import inputWrapperSource from "../../php/input-wrapper.php";
import libSource from "../../php/lib.php";
import curlPolyfillSource from "../../php/curl-polyfill.php";
import {gunzip, iterTar} from "./tar";
import {ensureDir, type PhpBinary, type PhpFS} from "./php-instance";

/**
 * Where the PHP-side runtime lives in the wasm FS. The prelude
 * `require_once`s it on every request: it registers the php://input
 * stream wrapper and defines \WorkersPHP\Env plus the binding classes.
 */
export const RUNTIME_LIBRARY_PATH = "/persist/workers-php-runtime.php";

/**
 * Separate from the runtime bundle because the polyfill declares global
 * functions, which requires a bracketed `namespace { … }` block — PHP
 * forbids mixing bracketed and unbracketed namespaces in one file.
 */
export const RUNTIME_CURL_POLYFILL_PATH = "/persist/workers-php-curl-polyfill.php";

export interface MountOptions {
	/** Absolute path on the wasm FS where the app should land. */
	appRoot: string;
	/** URL path inside the ASSETS bucket of the gzipped tarball. */
	assetPath: string;
	/** Strip a leading `<basename>/` prefix found inside the tarball. */
	stripPrefix?: string;
	/** Write/merge these into `<appRoot>/.env` after extraction. */
	envOverrides?: Record<string, string>;
	/** Optional logger for mount events. */
	log?: (msg: string) => void;
}

// Cached per isolate, so the tarball is fetched and extracted at most
// once per (appRoot, assetPath) pair.
const mounts = new Map<string, Promise<void>>();

// The cache keys on app paths, not the instance — drop it when the PHP
// instance is replaced, or the fresh FS would never be re-populated.
export const clearMountCache = (): void => {
	mounts.clear();
};

const fetchAssetBytes = async (
	assets: Fetcher,
	assetPath: string,
): Promise<Uint8Array> => {
	const url = `https://workers-php.internal/${assetPath.replace(/^\//, "")}`;
	const res = await assets.fetch(url);
	if (!res.ok) {
		throw new Error(
			`workers-php: ASSETS.fetch('${assetPath}') failed: ${res.status} ${res.statusText}`,
		);
	}
	const buf = await res.arrayBuffer();
	return new Uint8Array(buf);
};

/** Merge envOverrides into the existing .env (creating if missing). */
const writeEnvFile = (
	fs: PhpFS,
	appRoot: string,
	overrides: Record<string, string>,
): void => {
	const path = `${appRoot}/.env`;
	let existing = "";
	if (fs.analyzePath(path).exists && fs.readFile) {
		try {
			const raw = fs.readFile(path, {encoding: "utf8"});
			existing = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
		} catch {
			existing = "";
		}
	}
	// Strip each overridden key from the existing content (any line starting
	// with KEY= or commented-out #KEY=); then append the new values.
	let merged = existing;
	for (const key of Object.keys(overrides)) {
		const re = new RegExp(`^#?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "gm");
		merged = merged.replace(re, "");
	}
	merged = merged.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
	for (const [k, v] of Object.entries(overrides)) {
		const needsQuote = /[\s"'#]/.test(v);
		const safe = needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v;
		merged += `${k}=${safe}\n`;
	}
	fs.writeFile(path, merged, {encoding: "utf8"});
};

export const ensureMounted = (
	php: PhpWeb,
	assets: Fetcher,
	opts: MountOptions,
): Promise<void> => {
	const key = `${opts.appRoot}\0${opts.assetPath}`;
	const cached = mounts.get(key);
	if (cached) return cached;

	const log = opts.log ?? (() => {});
	const promise = (async () => {
		const t0 = Date.now();
		const binary = (await php.binary) as PhpBinary;

		const gz = await fetchAssetBytes(assets, opts.assetPath);
		const tar = await gunzip(gz);
		log(
			`mount: fetched ${gz.byteLength} B / gunzip → ${tar.byteLength} B in ${Date.now() - t0}ms`,
		);

		ensureDir(binary.FS, opts.appRoot);

		// analyzePath is a wasm call per path segment — far too costly to
		// run for every entry (Laravel ships ~7k files, ~6 deep). Track
		// known dirs and mkdir only missing ancestors; tar lists parents
		// before children in practice, so this is O(1) per entry.
		const knownDirs = new Set<string>();
		for (let p = opts.appRoot; p; p = p.slice(0, p.lastIndexOf("/"))) {
			knownDirs.add(p);
		}
		const mkdirs = (dir: string): void => {
			if (!dir || knownDirs.has(dir)) return;
			mkdirs(dir.slice(0, dir.lastIndexOf("/")));
			try {
				binary.FS.mkdir(dir);
			} catch {
				// Already exists.
			}
			knownDirs.add(dir);
		};

		let files = 0;
		let dirs = 0;
		const strip = opts.stripPrefix
			? opts.stripPrefix.replace(/\/$/, "") + "/"
			: undefined;

		for (const entry of iterTar(tar)) {
			let rel = entry.name;
			if (strip && rel.startsWith(strip)) {
				rel = rel.slice(strip.length);
			}
			// Skip the bare top-level entry of the tarball.
			if (!rel || rel === "./") continue;
			rel = rel.replace(/^\.\//, "");

			const dest = `${opts.appRoot}/${rel.replace(/\/$/, "")}`;

			if (entry.type === "dir") {
				mkdirs(dest);
				dirs++;
			} else if (entry.type === "file") {
				mkdirs(dest.slice(0, dest.lastIndexOf("/")));
				try {
					binary.FS.writeFile(dest, entry.data);
				} catch (err) {
					log(`mount: skipped ${dest}: ${(err as Error).message}`);
				}
				files++;
			}
		}

		if (opts.envOverrides && Object.keys(opts.envOverrides).length > 0) {
			writeEnvFile(binary.FS, opts.appRoot, opts.envOverrides);
		}

		// One bundled file per require: lib.php + input-wrapper (its `<?php`
		// stripped) + a require line pulling in the polyfill, which must
		// stay a separate file (see RUNTIME_CURL_POLYFILL_PATH).
		ensureDir(binary.FS, "/persist");
		const inputWrapperBody = inputWrapperSource.replace(/^<\?php\s*/, "");
		binary.FS.writeFile(
			RUNTIME_LIBRARY_PATH,
			libSource +
				"\n\n" +
				inputWrapperBody +
				"\n\n" +
				`require_once '${RUNTIME_CURL_POLYFILL_PATH}';\n`,
		);
		binary.FS.writeFile(RUNTIME_CURL_POLYFILL_PATH, curlPolyfillSource);

		log(
			`mount: ${files} files, ${dirs} dirs at ${opts.appRoot} in ${Date.now() - t0}ms`,
		);
	})();

	// On failure, drop the cache entry so the next request retries (rather
	// than serving a permanently-broken handler).
	promise.catch(() => mounts.delete(key));

	mounts.set(key, promise);
	return promise;
};
