import {describe, it, expect} from "vitest";
import {iterTar, gunzip} from "../src/runtime/tar";

// Minimal POSIX ustar block builder for tests.
const BLOCK = 512;
const encoder = new TextEncoder();

const writeString = (buf: Uint8Array, off: number, s: string, len: number) => {
	const bytes = encoder.encode(s);
	buf.set(bytes.subarray(0, Math.min(bytes.length, len)), off);
};

const writeOctal = (buf: Uint8Array, off: number, n: number, len: number) => {
	const s = n.toString(8).padStart(len - 1, "0") + "\0";
	writeString(buf, off, s, len);
};

const checksum = (buf: Uint8Array, off: number) => {
	// Spaces in checksum field for computation.
	for (let i = 0; i < 8; i++) buf[off + 148 + i] = 0x20;
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += buf[off + i];
	const s = sum.toString(8).padStart(6, "0") + "\0 ";
	writeString(buf, off + 148, s, 8);
};

const buildHeader = (name: string, size: number, type: string): Uint8Array => {
	const hdr = new Uint8Array(BLOCK);
	writeString(hdr, 0, name, 100);
	writeOctal(hdr, 100, 0o644, 8);
	writeOctal(hdr, 108, 0, 8); // uid
	writeOctal(hdr, 116, 0, 8); // gid
	writeOctal(hdr, 124, size, 12);
	writeOctal(hdr, 136, 0, 12); // mtime
	hdr[156] = type.charCodeAt(0);
	writeString(hdr, 257, "ustar", 6);
	writeString(hdr, 263, "00", 2);
	checksum(hdr, 0);
	return hdr;
};

const padToBlock = (data: Uint8Array): Uint8Array => {
	const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
	if (!pad) return data;
	const out = new Uint8Array(data.length + pad);
	out.set(data);
	return out;
};

const buildTar = (
	entries: Array<{name: string; data?: string; type?: "file" | "dir"}>,
): Uint8Array => {
	const parts: Uint8Array[] = [];
	for (const e of entries) {
		const isDir = e.type === "dir";
		const bytes = isDir ? new Uint8Array(0) : encoder.encode(e.data ?? "");
		parts.push(buildHeader(e.name, bytes.length, isDir ? "5" : "0"));
		if (bytes.length) parts.push(padToBlock(bytes));
	}
	// Two zero blocks for end-of-archive.
	parts.push(new Uint8Array(BLOCK * 2));
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
};

describe("iterTar", () => {
	it("yields a single file entry", () => {
		const tar = buildTar([{name: "hello.txt", data: "world!"}]);
		const entries = [...iterTar(tar)];
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("hello.txt");
		expect(entries[0].type).toBe("file");
		expect(new TextDecoder().decode(entries[0].data)).toBe("world!");
	});

	it("yields multiple files and a directory", () => {
		const tar = buildTar([
			{name: "app/", type: "dir"},
			{name: "app/a.php", data: "<?php\necho 1;"},
			{name: "app/b.php", data: "<?php\necho 2;"},
		]);
		const entries = [...iterTar(tar)];
		expect(entries.map((e) => [e.type, e.name])).toEqual([
			["dir", "app/"],
			["file", "app/a.php"],
			["file", "app/b.php"],
		]);
		expect(new TextDecoder().decode(entries[1].data)).toBe("<?php\necho 1;");
		expect(new TextDecoder().decode(entries[2].data)).toBe("<?php\necho 2;");
	});

	it("stops at the end-of-archive zero blocks", () => {
		const tar = buildTar([{name: "only.txt", data: "ok"}]);
		// Append more junk past the EOF marker; iterTar should not yield it.
		const longer = new Uint8Array(tar.length + 1024);
		longer.set(tar);
		longer.fill(0x41, tar.length); // 'A' bytes after EOF
		const entries = [...iterTar(longer)];
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("only.txt");
	});

	it("handles files whose size is exactly a block boundary", () => {
		// 512 bytes of data; the entry occupies one block of payload (no pad).
		const blob = "x".repeat(512);
		const tar = buildTar([{name: "block.bin", data: blob}]);
		const entries = [...iterTar(tar)];
		expect(entries).toHaveLength(1);
		expect(entries[0].data.length).toBe(512);
	});
});

describe("gunzip", () => {
	it("decompresses a known gzip payload", async () => {
		// gzip("hello"), produced via:
		//   printf hello | gzip -nc | xxd -p
		const hex =
			"1f8b0800000000000003cb48cdc9c9070086a6103605000000";
		const bytes = new Uint8Array(hex.length / 2);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		}
		const out = await gunzip(bytes);
		expect(new TextDecoder().decode(out)).toBe("hello");
	});
});
