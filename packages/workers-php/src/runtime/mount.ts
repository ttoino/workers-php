// Mount an ASSETS-backed `app.tar.gz` into the PHP wasm filesystem on the
// first request, idempotent and cached for the isolate's lifetime.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import {gunzip, iterTar} from "./tar";
import {ensureDir, type PhpBinary, type PhpFS} from "./php-instance";

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

// Cache mount promises per (appRoot, assetPath) pair across requests in
// the same isolate. Map value is the promise that resolves once mounted.
const mounts = new Map<string, Promise<void>>();

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

		// Create the appRoot parent chain.
		ensureDir(binary.FS, opts.appRoot);

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
				ensureDir(binary.FS, dest);
				dirs++;
			} else if (entry.type === "file") {
				const parent = dest.slice(0, dest.lastIndexOf("/"));
				if (parent) ensureDir(binary.FS, parent);
				try {
					binary.FS.writeFile(dest, entry.data);
				} catch (err) {
					// Permission denied / weird path — skip but warn.
					log(`mount: skipped ${dest}: ${(err as Error).message}`);
				}
				files++;
			}
		}

		if (opts.envOverrides && Object.keys(opts.envOverrides).length > 0) {
			writeEnvFile(binary.FS, opts.appRoot, opts.envOverrides);
		}

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
