// Minimal POSIX ustar extractor. Handles the entry types `tar czf` produces
// for the Laravel skeleton (regular files, directories, long-name extensions).

export interface TarEntry {
	name: string;
	type: "file" | "dir" | "other";
	data: Uint8Array;
}

const decoder = new TextDecoder("utf-8");

const readString = (buf: Uint8Array, off: number, len: number): string => {
	let end = off;
	const limit = off + len;
	while (end < limit && buf[end] !== 0) end++;
	return decoder.decode(buf.subarray(off, end));
};

const readOctal = (buf: Uint8Array, off: number, len: number): number => {
	const s = readString(buf, off, len).trim();
	if (!s) return 0;
	return parseInt(s, 8);
};

const BLOCK = 512;

export function* iterTar(tar: Uint8Array): Generator<TarEntry> {
	let off = 0;
	let pendingLongName: string | null = null;

	while (off + BLOCK <= tar.length) {
		// Two consecutive zero blocks mark end-of-archive.
		const isZero = tar[off] === 0 && tar[off + 1] === 0 && tar[off + 100] === 0;
		if (isZero) break;

		let name = readString(tar, off, 100);
		const size = readOctal(tar, off + 124, 12);
		const typeflag = String.fromCharCode(tar[off + 156] || 0x30);
		const prefix = readString(tar, off + 345, 155);

		const dataStart = off + BLOCK;
		const dataEnd = dataStart + size;
		const padded = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		if (typeflag === "L") {
			// GNU long-name: the next entry's name is the data of this one.
			pendingLongName = readString(tar, dataStart, size);
			off = padded;
			continue;
		}

		if (pendingLongName !== null) {
			name = pendingLongName;
			pendingLongName = null;
		} else if (prefix) {
			name = `${prefix}/${name}`;
		}

		let type: TarEntry["type"];
		if (typeflag === "5") type = "dir";
		else if (typeflag === "0" || typeflag === "\0") type = "file";
		else type = "other"; // symlinks, hard links, etc. — skipped by callers

		yield {
			name,
			type,
			data: tar.subarray(dataStart, dataEnd),
		};

		off = padded;
	}
}

/** Gunzip a tar.gz blob using the runtime's DecompressionStream. */
export async function gunzip(gz: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
	const stream = new Response(gz).body!.pipeThrough(new DecompressionStream("gzip"));
	const buf = await new Response(stream).arrayBuffer();
	return new Uint8Array(buf);
}
