// Singleton PhpWeb instance + per-isolate request lock.
//
// We hold a single PhpWeb across all requests in the isolate because the
// wasm runtime is multi-megabyte and instantiation is expensive. PHP global
// state is reset between requests via `php.refresh()` which calls
// `pib_refresh` in the wasm.
//
// All PHP work is serialized through `requestChain` because PHP itself is
// not reentrant: concurrent runs would interleave stdout/stderr and corrupt
// global state.

import {PhpWeb} from "../wasm/PhpWeb.mjs";
import phpWasm from "../wasm/php-web.wasm";

export interface PhpFS {
	analyzePath: (path: string) => {exists: boolean; object?: unknown};
	mkdir: (path: string, mode?: number) => void;
	writeFile: (path: string, data: string | Uint8Array, opts?: object) => void;
	readFile?: (path: string, opts?: object) => Uint8Array | string;
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

let requestChain: Promise<unknown> = Promise.resolve();

export const withPhpLock = <T>(fn: () => Promise<T>): Promise<T> => {
	const next = requestChain.then(fn, fn);
	// Swallow rejections on the chain so one failing request doesn't poison
	// every subsequent request in this isolate.
	requestChain = next.catch(() => undefined);
	return next;
};

/** Helper: idempotently mkdir -p on the wasm FS. */
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
