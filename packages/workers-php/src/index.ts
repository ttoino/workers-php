// workers-php — run a PHP project on Cloudflare Workers, with the project
// stored as static assets (so it doesn't count against the Worker bundle
// size cap) and dispatched to PHP via WebAssembly.
//
// See https://github.com/anomalyco/workers-php for usage.

export {createPhpHandler} from "./runtime/handler";
export type {
	PhpHandler,
	PhpHandlerOptions,
	BindingKind,
	BindingDeclarations,
	StaticRoute,
} from "./runtime/handler";

// Lower-level building blocks. Most users won't need these; expose them
// in case someone wants to compose a custom handler.
export {getPhp, withPhpLock} from "./runtime/php-instance";
export {ensureMounted} from "./runtime/mount";
export type {MountOptions} from "./runtime/mount";
export {buildPrelude, parseOutput, buildEpilogue, phpQuoteString} from "./runtime/cgi";
export type {PreludeOptions, CapturedOutput} from "./runtime/cgi";
export {isStaticRequest, DEFAULT_STATIC_EXTENSIONS} from "./runtime/static";
export {gunzip, iterTar} from "./runtime/tar";
export type {TarEntry} from "./runtime/tar";
export {installBridge, setBridgeMethods} from "./runtime/bridge";
export type {BridgeMethods} from "./runtime/bridge";
