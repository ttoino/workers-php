// JS↔PHP bridge installer.
//
// The bundled `workers_php_bridge` C extension exposes a single PHP
// function `workers_php_call(string $method, array $args)`. Its
// EM_ASYNC_JS implementation looks up `Module.workersPhpBridge[$method]`
// and awaits its return value. This module is how we install that table.
//
// One install per PHP wasm Module is enough — the table persists across
// `pib_refresh` calls (it lives on the JS Module object). We call
// `installBridge` once at handler construction time, then individual
// requests can mutate the table contents safely via `setBridgeMethods`.

import type {PhpWeb} from "../wasm/PhpWeb.mjs";

/** Map from method name to JS handler. Handlers are called with the
 *  arguments PHP passed to `workers_php_call($method, $args)`. The
 *  return value is JSON-serialised and decoded into PHP; throwing
 *  surfaces as `\WorkersPHP\BridgeException` in PHP. */
export type BridgeMethods = Record<string, (...args: never[]) => unknown | Promise<unknown>>;

interface PhpBinaryWithBridge {
	workersPhpBridge?: BridgeMethods;
}

/** Install (or replace) the bridge method table on the wasm Module. */
export const installBridge = async (
	php: PhpWeb,
	methods: BridgeMethods,
): Promise<void> => {
	const binary = (await php.binary) as PhpBinaryWithBridge;
	binary.workersPhpBridge = methods;
};

/** Replace just specific entries on the existing table, preserving others.
 *  Use this from a handler's per-request setup to thread `env`-scoped
 *  closures (e.g. `d1_query` bound to `env.DB`) without touching unrelated
 *  bindings. */
export const setBridgeMethods = async (
	php: PhpWeb,
	methods: BridgeMethods,
): Promise<void> => {
	const binary = (await php.binary) as PhpBinaryWithBridge;
	binary.workersPhpBridge = {...(binary.workersPhpBridge ?? {}), ...methods};
};
