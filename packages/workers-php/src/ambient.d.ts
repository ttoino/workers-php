declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}

declare module "*.bin" {
	const data: ArrayBuffer;
	export default data;
}

declare module "*.php" {
	const source: string;
	export default source;
}

declare module "../wasm/PhpWeb.mjs" {
	export class PhpWeb extends EventTarget {
		constructor(args?: object);
		binary: Promise<unknown>;
		run(code: string): Promise<number>;
		exec(code: string): Promise<string>;
		refresh(): Promise<number>;
		input(items: Uint8Array | number[]): void;
		inputString(s: string): void;
		flush(): void;
	}
}
