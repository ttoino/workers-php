#!/usr/bin/env node
/**
 * workers-php CLI: `workers-php build [project-dir] [options]`
 *
 * Bundles a PHP project into a gzipped tarball that the runtime mounts
 * from the Worker's ASSETS binding on first request.
 *
 * Requires GNU tar on PATH (Linux/macOS/WSL).
 */

import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {resolve, dirname, join, relative} from "node:path";

const C_BOLD = "\x1b[1m";
const C_GREEN = "\x1b[32m";
const C_YELLOW = "\x1b[33m";
const C_RED = "\x1b[31m";
const C_DIM = "\x1b[2m";
const C_RESET = "\x1b[0m";

const log = (...a) => console.log(`${C_BOLD}==>${C_RESET}`, ...a);
const ok = (...a) => console.log(`${C_GREEN}✓${C_RESET}`, ...a);
const warn = (...a) => console.error(`${C_YELLOW}warning:${C_RESET}`, ...a);
const fail = (...a) => {
	console.error(`${C_RED}error:${C_RESET}`, ...a);
	process.exit(1);
};

const usage = () => {
	console.log(`workers-php — bundle a PHP project for Cloudflare Workers

USAGE:
  workers-php build [project] [options]

ARGUMENTS:
  project                  Directory containing the PHP project. Default: ./php

OPTIONS:
  --out, -o <dir>          Output directory for built assets. Default: ./dist
  --docroot <subpath>      Document root, relative to project. Default: public
  --entrypoint <file>      Entrypoint file inside docroot. Default: index.php
  --ignore-file <path>     Path to ignore patterns. Default: <project>/.workersphpignore
  --write-config           Merge the assets block into ./wrangler.jsonc
  --quiet, -q              Suppress non-error output
  --help, -h               Show this help

EXAMPLE:
  workers-php build ./my-php-app --out ./dist --write-config
`);
};

const parseArgs = (argv) => {
	const args = {
		_: [],
		out: "./dist",
		docroot: "public",
		entrypoint: "index.php",
		ignoreFile: null,
		writeConfig: false,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i] ?? fail(`missing argument for ${a}`);
		switch (a) {
			case "--out":
			case "-o":
				args.out = next();
				break;
			case "--docroot":
				args.docroot = next();
				break;
			case "--entrypoint":
				args.entrypoint = next();
				break;
			case "--ignore-file":
				args.ignoreFile = next();
				break;
			case "--write-config":
				args.writeConfig = true;
				break;
			case "--quiet":
			case "-q":
				args.quiet = true;
				break;
			case "--help":
			case "-h":
				usage();
				process.exit(0);
				break;
			default:
				if (a.startsWith("-")) fail(`unknown option: ${a}`);
				args._.push(a);
		}
	}
	return args;
};

// GNU tar matches excludes against the traversal name ("./dist"), which
// never ends in a slash — trailing-slash patterns silently never match.
const DEFAULT_IGNORES = [
	".git",
	".gitignore",
	".gitattributes",
	".editorconfig",
	"node_modules",
	// wrangler dev's local state (contains multi-MB wasm copies under tmp/).
	".wrangler",
	".env.example",
	".env.testing",
	"tests",
	"test",
	"*.md",
	"*.dist",
	"phpunit.xml",
	"phpunit.xml.dist",
	"CHANGELOG*",
	"LICENSE*",
	"README*",
	"storage/logs",
	"storage/framework/cache/data",
	"storage/framework/sessions",
	"storage/framework/views",
];

const checkTar = () => {
	const r = spawnSync("tar", ["--version"], {encoding: "utf8"});
	if (r.status !== 0) {
		fail(
			"GNU tar not found on PATH. Install tar (Linux/macOS) or use WSL on Windows.",
		);
	}
};

const sanityCheck = (projectDir, docroot, entrypoint) => {
	if (!existsSync(projectDir)) fail(`project directory not found: ${projectDir}`);
	const entry = join(projectDir, docroot, entrypoint);
	if (!existsSync(entry)) {
		fail(
			`entrypoint not found: ${entry}\n` +
				`  Check --docroot and --entrypoint, or create ${docroot}/${entrypoint}.`,
		);
	}
	const st = statSync(entry);
	if (!st.isFile()) fail(`entrypoint is not a file: ${entry}`);
};

const writeExcludeFile = (path, patterns) => {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, patterns.join("\n") + "\n", "utf8");
};

const buildTarball = (projectDir, outFile, ignoreFile, quiet) => {
	mkdirSync(dirname(outFile), {recursive: true});
	// Every entry lands under `app/`, which the runtime removes again via
	// stripPrefix.
	const tarArgs = [
		"-czf",
		outFile,
		"-C",
		projectDir,
		"--exclude-from",
		ignoreFile,
		"--transform",
		"s,^\\./,app/,",
		"--owner=0",
		"--group=0",
		"--mtime=1970-01-01 00:00:00 UTC",
		".",
	];
	const r = spawnSync("tar", tarArgs, {
		stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
	});
	if (r.status !== 0) fail(`tar exited with code ${r.status}`);
};

const sha256File = (path) => {
	const buf = readFileSync(path);
	return createHash("sha256").update(buf).digest("hex");
};

const fileCount = (dir, ignores) => {
	// Approximate count for logging; skips a few common non-app dirs.
	let n = 0;
	const walk = (d) => {
		for (const name of readdirSync(d, {withFileTypes: true})) {
			if (
				name.name === ".git" ||
				name.name === "node_modules" ||
				name.name === "tests"
			)
				continue;
			const p = join(d, name.name);
			if (name.isDirectory()) walk(p);
			else if (name.isFile()) n++;
		}
	};
	try {
		walk(dir);
	} catch {
		// best-effort
	}
	return n;
};

const wranglerSnippet = (assetsDir, projectBase) => `
{
  "assets": {
    "directory": "${assetsDir}",
    "binding": "ASSETS",
    "run_worker_first": true
  }
}
`;

/** Add/replace the assets block in wrangler.jsonc. Comments are stripped
 *  rather than preserved (no JSONC AST here); a banner marks the file as
 *  touched by workers-php. */
const mergeWranglerConfig = (configPath, assetsDir) => {
	if (!existsSync(configPath)) {
		const initial = {
			$schema: "node_modules/wrangler/config-schema.json",
			compatibility_date: new Date().toISOString().slice(0, 10),
			assets: {
				directory: assetsDir,
				binding: "ASSETS",
				run_worker_first: true,
			},
		};
		writeFileSync(configPath, JSON.stringify(initial, null, 2) + "\n");
		ok(`wrote new ${configPath}`);
		return;
	}
	let raw = readFileSync(configPath, "utf8");
	const stripped = raw
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
	let parsed;
	try {
		parsed = JSON.parse(stripped);
	} catch (e) {
		fail(
			`could not parse ${configPath}: ${e.message}\n` +
				"  Re-run without --write-config and merge the assets block manually.",
		);
	}
	const existing = parsed.assets ?? {};
	parsed.assets = {
		...existing,
		directory: assetsDir,
		binding: existing.binding ?? "ASSETS",
		run_worker_first:
			existing.run_worker_first === undefined ? true : existing.run_worker_first,
	};
	writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
	ok(`updated ${configPath} (assets block merged in)`);
	if (raw.includes("//") || raw.includes("/*")) {
		warn(
			`${configPath} previously contained JSONC comments; those were stripped.`,
		);
	}
};

const cmdBuild = (argv) => {
	const args = parseArgs(argv);
	const projectDir = resolve(args._[0] ?? "./php");
	const outDir = resolve(args.out);
	const outFile = join(outDir, "app.tar.gz");

	checkTar();
	sanityCheck(projectDir, args.docroot, args.entrypoint);

	const ignoreFile = args.ignoreFile
		? resolve(args.ignoreFile)
		: join(projectDir, ".workersphpignore");

	let userIgnores = [];
	if (existsSync(ignoreFile)) {
		userIgnores = readFileSync(ignoreFile, "utf8")
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s && !s.startsWith("#"));
		if (!args.quiet)
			log(`using ignore file: ${relative(process.cwd(), ignoreFile)}`);
	}
	// An out dir inside the project would otherwise tar itself (and stale
	// tarballs from previous builds) — exclude it path-relative.
	const relOut = relative(projectDir, outDir);
	if (relOut && !relOut.startsWith("..") && relOut !== ".") {
		userIgnores.push(relOut.replace(/\\/g, "/"));
	}
	const allIgnores = [...DEFAULT_IGNORES, ...userIgnores];

	// Write the exclude list to a temp file *outside* outDir so it doesn't
	// itself end up in the ASSETS bundle.
	const excludeFile = join(tmpdir(), `workers-php-exclude.${process.pid}`);
	writeExcludeFile(excludeFile, allIgnores);
	process.on("exit", () => {
		try { unlinkSync(excludeFile); } catch {}
	});

	if (!args.quiet) {
		log(`bundling ${relative(process.cwd(), projectDir)} → ${relative(process.cwd(), outFile)}`);
		const approxFiles = fileCount(projectDir, allIgnores);
		log(`approximate file count (pre-ignore): ${approxFiles}`);
	}

	const t0 = Date.now();
	buildTarball(projectDir, outFile, excludeFile, args.quiet);

	const size = statSync(outFile).size;
	const hash = sha256File(outFile);
	const manifest = {
		generated_at: new Date().toISOString(),
		project: relative(process.cwd(), projectDir),
		docroot: args.docroot,
		entrypoint: args.entrypoint,
		tarball: "app.tar.gz",
		size,
		sha256: hash,
	};
	writeFileSync(
		join(outDir, "manifest.json"),
		JSON.stringify(manifest, null, 2) + "\n",
	);

	ok(`wrote ${relative(process.cwd(), outFile)} (${(size / 1024 / 1024).toFixed(2)} MB) in ${Date.now() - t0}ms`);
	if (!args.quiet) {
		console.log(`${C_DIM}      sha256: ${hash.slice(0, 16)}…${C_RESET}`);
		console.log(
			`${C_DIM}      manifest: ${relative(process.cwd(), join(outDir, "manifest.json"))}${C_RESET}`,
		);
	}

	if (args.writeConfig) {
		const cfg = existsSync("wrangler.jsonc")
			? "wrangler.jsonc"
			: existsSync("wrangler.json")
				? "wrangler.json"
				: "wrangler.jsonc";
		mergeWranglerConfig(cfg, relative(process.cwd(), outDir) || ".");
	} else if (!args.quiet) {
		console.log(
			`\n${C_BOLD}Add this to your wrangler.jsonc:${C_RESET}${wranglerSnippet(
				relative(process.cwd(), outDir) || ".",
			)}\nThen \`wrangler dev\` or \`wrangler deploy\`.\n`,
		);
	}
};

const main = () => {
	const [, , cmd, ...rest] = process.argv;
	if (!cmd || cmd === "--help" || cmd === "-h") {
		usage();
		process.exit(cmd ? 0 : 1);
	}
	switch (cmd) {
		case "build":
			cmdBuild(rest);
			break;
		default:
			fail(`unknown command: ${cmd}\n(try \`workers-php --help\`)`);
	}
};

main();
