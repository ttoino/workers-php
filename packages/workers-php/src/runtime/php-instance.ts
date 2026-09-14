// Singleton PhpWeb instance + per-isolate request lock.
//
// One PhpWeb is shared across the isolate: instantiation of the
// multi-megabyte wasm runtime is expensive, so PHP global state is reset
// between requests via `php.refresh()` instead.
//
// PHP is not reentrant — concurrent runs would interleave stdout/stderr
// and corrupt global state — so all work serializes through `requestChain`.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import phpWasm from "../wasm/php-web.wasm";

export interface PhpFS {
	analyzePath: (path: string) => {exists: boolean; object?: unknown};
	mkdir: (path: string, mode?: number) => void;
	writeFile: (path: string, data: string | Uint8Array, opts?: object) => void;
	readFile?: (path: string, opts?: object) => Uint8Array | string;
	unlink?: (path: string) => void;
}

export interface PhpBinary {
	FS: PhpFS;
}

let phpInstance: PhpWeb | null = null;

export const getPhp = (): PhpWeb => {
	if (!phpInstance) {
		phpInstance = new PhpWeb({
			instantiateWasm(
				info: WebAssembly.Imports,
				receive: (instance: WebAssembly.Instance) => void,
			) {
				const instance = new WebAssembly.Instance(phpWasm, info);
				receive(instance);
				return instance.exports;
			},
			locateFile: () => undefined,
		});
	}
	return phpInstance;
};

let requestsServed = 0;

// wasm linear memory only grows within an instance; refresh() resets PHP
// globals but not the heap. Dropping the instance lets V8 GC the whole
// module — the only way to reclaim memory inside a long-lived isolate.
// Any per-instance caches (e.g. the mount cache) must be cleared by the
// caller. File-backed session state on the wasm FS dies with the instance.
export const retirePhp = (maxRequestsPerInstance: number): boolean => {
	if (maxRequestsPerInstance <= 0) return false;
	requestsServed += 1;
	if (requestsServed < maxRequestsPerInstance) return false;
	requestsServed = 0;
	phpInstance = null;
	return true;
};

let requestChain: Promise<unknown> = Promise.resolve();

export const withPhpLock = <T>(fn: () => Promise<T>): Promise<T> => {
	const next = requestChain.then(fn, fn);
	// Swallow rejections on the chain so one failing request doesn't poison
	// every subsequent request in this isolate.
	requestChain = next.catch(() => undefined);
	return next;
};

/** mkdir -p on the wasm FS. */
export const ensureDir = (fs: PhpFS, path: string): void => {
	const segments = path.split("/").filter(Boolean);
	let cur = "";
	for (const seg of segments) {
		cur += "/" + seg;
		if (!fs.analyzePath(cur).exists) {
			try {
				fs.mkdir(cur);
			} catch {
				// Race / already exists / etc.
			}
		}
	}
};
