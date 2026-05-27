// Cloudflare-Workers-compatible PhpWeb wrapper.
//
// Upstream PhpWeb.mjs (a) does a switch-case of `import(`./phpX.Y-web.mjs`)`
// across every supported PHP version — esbuild (Wrangler's bundler) can't
// statically resolve dynamic imports for files we don't ship — and (b) uses
// `navigator.locks.request` which doesn't exist in the Cloudflare Workers
// runtime.
//
// This replacement just imports our single php-web.mjs and skips the lock /
// transaction machinery (Workers has no IndexedDB-backed FS to sync).

import { PhpBase } from './PhpBase.mjs';
import PhpBinary from './php-web.mjs';

export class PhpWeb extends PhpBase
{
	constructor(args = {})
	{
		super(Promise.resolve({default: PhpBinary}), args);
	}

	async refresh()
	{
		return super.refresh();
	}

	/**
	 * Override upstream's `_run` to pass `{async: true}` to `ccall('pib_run')`.
	 *
	 * When PHP code inside the script suspends the wasm stack via
	 * Emscripten's Asyncify (e.g. an `EM_ASYNC_JS` call from our
	 * `workers_php_bridge` extension), the underlying `pib_run` returns a
	 * Promise. Upstream's `_run` doesn't pass `{async: true}` to ccall,
	 * which means ccall returns immediately with `undefined` while the
	 * wasm is still mid-suspend. We need the await to actually wait.
	 *
	 * @param {string} phpCode
	 */
	_run(phpCode)
	{
		return this.binary.then(php => php.ccall(
			'pib_run',
			'number',
			['string'],
			[`?>${phpCode}`],
			{ async: true }
		)).finally(() => this.flush());
	}

	async _enqueue(callback, params = [], readOnly = false)
	{
		await this.binary;

		let accept, reject;
		const coordinator = new Promise((a, r) => [accept, reject] = [a, r]);
		this.queue.push([callback, params, accept, reject]);

		if (this.queue.length > 1) {
			// Another invocation is already draining the queue.
			return coordinator;
		}

		(async () => {
			while (this.queue.length) {
				const [cb, ps, ok, ko] = this.queue.shift();
				try {
					ok(await cb(...ps));
				} catch (e) {
					ko(e);
				}
			}
		})();

		return coordinator;
	}

	// Stub the transaction methods upstream calls — IndexedDB doesn't exist here.
	startTransaction() { return Promise.resolve(); }
	commitTransaction() { return Promise.resolve(); }
}
