// Mount path performance + robustness. The untar loop must not stat
// every path segment (analyzePath is a wasm call), and must tolerate
// tars whose entries are not in parent-first order.

import {gzipSync} from "node:zlib";
import {describe, expect, it} from "vitest";
import {ensureMounted} from "../src/runtime/mount";
import type {PhpBinary} from "../src/runtime/php-instance";
import type {PhpWeb} from "../src/wasm/PhpWeb.mjs";
import {buildTar, makeMockAssets, mockCtx} from "./helpers";
import {createPhpHandler} from "../src/index";

const makeFakeFS = () => {
	const dirs = new Set(["/", "/persist"]);
	const files = new Map<string, Uint8Array>();
	const calls = {analyzePath: 0, mkdir: 0};
	const normalize = (p: string) => p.replace(/\/+$/, "") || "/";
	const fs = {
		analyzePath(path: string) {
			calls.analyzePath++;
			const p = normalize(path);
			return {exists: dirs.has(p) || files.has(p)};
		},
		mkdir(path: string) {
			calls.mkdir++;
			const p = normalize(path);
			if (dirs.has(p)) throw new Error("File exists");
			dirs.add(p);
		},
		writeFile(path: string, data: string | Uint8Array) {
			const p = normalize(path);
			const parent = p.slice(0, p.lastIndexOf("/")) || "/";
			if (!dirs.has(parent)) throw new Error("no such dir");
			files.set(
				p,
				typeof data === "string" ? new TextEncoder().encode(data) : data,
			);
		},
	};
	return {calls, files, fs};
};

describe("ensureMounted", () => {
	it("creates dirs without per-segment analyzePath calls", async () => {
		const FILE_COUNT = 1500;
		const entries: Array<{name: string; data?: string; type?: "file" | "dir"}> = [
			{name: "app/", type: "dir"},
		];
		// Files only, no intermediate dir entries: mkdir recursion must
		// create every ancestor. 6 levels deep × 1500 files.
		for (let i = 0; i < FILE_COUNT; i++) {
			entries.push({
				name: `app/a/b/c/d/e/f/file-${i}.txt`,
				data: `content-${i}`,
			});
		}

		const fake = makeFakeFS();
		const php = {
			binary: Promise.resolve({FS: fake.fs} as PhpBinary),
		} as unknown as PhpWeb;
		const assets = makeMockAssets(new Uint8Array(gzipSync(buildTar(entries))));

		await ensureMounted(php, assets, {
			appRoot: "/persist/mount-unit",
			assetPath: "/app.tar.gz",
			stripPrefix: "app",
		});

		expect(fake.files.size).toBe(FILE_COUNT + 2); // + runtime library files
		expect(fake.files.get("/persist/mount-unit/a/b/c/d/e/f/file-0.txt"))
			.toEqual(new TextEncoder().encode("content-0"));
		// The only analyzePath calls left are ensureDir's for appRoot and
		// /persist — constant, not O(files × depth).
		expect(fake.calls.analyzePath).toBeLessThanOrEqual(10);
	});

	it(
		"mounts unordered tar entries (file before its parent dir)",
		async () => {
			const phpCode = `<?php
header('Content-Type: text/plain');
echo file_get_contents('/persist/mount-it/deep/nested/hello.txt');
`;
			const tar = buildTar([
				{name: "app/", type: "dir"},
				{name: "app/index.php", data: phpCode},
				// Deliberately before its parent dir entries.
				{name: "app/deep/nested/hello.txt", data: "hi"},
				{name: "app/deep/", type: "dir"},
				{name: "app/deep/nested/", type: "dir"},
			]);
			const env = {
				ASSETS: makeMockAssets(new Uint8Array(gzipSync(tar))),
			};
			const handler = createPhpHandler({
				appRoot: "/persist/mount-it",
				docroot: ".",
				entrypoint: "index.php",
			});

			const res = await handler(
				new Request("https://example.com/"),
				env,
				mockCtx as unknown as ExecutionContext,
			);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("hi");
		},
		60000,
	);
});
