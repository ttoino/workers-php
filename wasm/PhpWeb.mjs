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
