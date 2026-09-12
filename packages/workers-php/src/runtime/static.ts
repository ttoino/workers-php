// Default list of file extensions whose requests should be short-circuited
// to the ASSETS binding rather than dispatched into PHP. Users can override
// or extend this via `PhpHandlerOptions.staticExtensions`.

export const DEFAULT_STATIC_EXTENSIONS: readonly string[] = [
	"css",
	"js",
	"mjs",
	"map",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"svg",
	"ico",
	"webp",
	"avif",
	"bmp",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"mp3",
	"mp4",
	"webm",
	"ogg",
	"wav",
	"flac",
	"pdf",
	"txt",
	"xml",
	"json",
	"wasm",
];

const lastSegment = (pathname: string): string => {
	const i = pathname.lastIndexOf("/");
	return i < 0 ? pathname : pathname.slice(i + 1);
};

/**
 * Match `/foo/bar.css` but not `/foo/bar.php?asset=css` or dotless
 * segments; paths ending in `/` never match.
 */
export const isStaticRequest = (pathname: string, exts: readonly string[]): boolean => {
	const seg = lastSegment(pathname);
	if (!seg || pathname.endsWith("/")) return false;
	const dot = seg.lastIndexOf(".");
	if (dot < 0 || dot === seg.length - 1) return false;
	const ext = seg.slice(dot + 1).toLowerCase();
	return exts.includes(ext);
};
