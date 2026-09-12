import {describe, it, expect} from "vitest";
import {
	buildPrelude,
	buildCapture,
	makeCaptureSlot,
	readCapture,
	parseOutput,
	buildEpilogue,
	buildShutdown,
	phpQuoteString,
} from "../src/runtime/cgi";

describe("phpQuoteString", () => {
	it("wraps a plain string in single quotes", () => {
		expect(phpQuoteString("hello")).toBe("'hello'");
	});

	it("escapes single quotes", () => {
		expect(phpQuoteString("it's")).toBe("'it\\'s'");
	});

	it("escapes backslashes", () => {
		expect(phpQuoteString("a\\b")).toBe("'a\\\\b'");
	});

	it("handles strings containing both", () => {
		expect(phpQuoteString("a\\'b")).toBe("'a\\\\\\'b'");
	});
});

describe("buildPrelude", () => {
	it("emits a $_SERVER array with REQUEST_METHOD/REQUEST_URI", async () => {
		const req = new Request("https://example.com/foo?bar=1");
		const src = (await buildPrelude(req)).phpSource;
		expect(src).toContain("$_SERVER");
		expect(src).toContain("'REQUEST_METHOD' => 'GET'");
		expect(src).toContain("'REQUEST_URI' => '/foo?bar=1'");
		expect(src).toContain("'QUERY_STRING' => 'bar=1'");
	});

	it("seeds $_GET from the URL", async () => {
		const req = new Request("https://example.com/?name=Workers&n=2");
		const src = (await buildPrelude(req)).phpSource;
		expect(src).toMatch(/\$_GET = \[.*'name' => 'Workers'.*\]/s);
		expect(src).toMatch(/\$_GET = \[.*'n' => '2'.*\]/s);
	});

	it("seeds $_POST from an application/x-www-form-urlencoded body", async () => {
		const req = new Request("https://example.com/post", {
			method: "POST",
			headers: {"content-type": "application/x-www-form-urlencoded"},
			body: "name=POST&val=42",
		});
		const src = (await buildPrelude(req)).phpSource;
		expect(src).toMatch(/\$_POST = \[.*'name' => 'POST'.*\]/s);
		expect(src).toMatch(/\$_POST = \[.*'val' => '42'.*\]/s);
	});

	it("seeds $_COOKIE from the Cookie header", async () => {
		const req = new Request("https://example.com/", {
			headers: {cookie: "session=abc; flag=on"},
		});
		const src = (await buildPrelude(req)).phpSource;
		expect(src).toMatch(/\$_COOKIE = \[.*'session' => 'abc'.*\]/s);
		expect(src).toMatch(/\$_COOKIE = \[.*'flag' => 'on'.*\]/s);
	});

	it("emits putenv() calls for envOverrides", async () => {
		const req = new Request("https://example.com/");
		const src = (await buildPrelude(req, {
			envOverrides: {APP_ENV: "production", DEBUG: "0"},
		})).phpSource;
		expect(src).toContain("putenv('APP_ENV=production');");
		expect(src).toContain("putenv('DEBUG=0');");
	});

	it("includes SCRIPT_FILENAME when provided", async () => {
		const req = new Request("https://example.com/");
		const src = (await buildPrelude(req, {
			scriptFilename: "/persist/app/public/index.php",
			documentRoot: "/persist/app/public",
		})).phpSource;
		expect(src).toContain(
			"'SCRIPT_FILENAME' => '/persist/app/public/index.php'",
		);
		expect(src).toContain("'DOCUMENT_ROOT' => '/persist/app/public'");
	});

	it("turns request headers into HTTP_* server vars", async () => {
		const req = new Request("https://example.com/", {
			headers: {"x-custom-header": "value"},
		});
		const src = (await buildPrelude(req)).phpSource;
		expect(src).toContain("'HTTP_X_CUSTOM_HEADER' => 'value'");
	});

	it("does not include a closing ?> (would emit unwanted output)", async () => {
		const req = new Request("https://example.com/");
		const src = (await buildPrelude(req)).phpSource;
		expect(src).not.toContain("?>");
	});
});

describe("parseOutput", () => {
	it("returns body unchanged when no CGI header block is present", () => {
		const result = parseOutput("just a body");
		expect(result.body).toBe("just a body");
		expect(result.status).toBe(200);
		expect([...result.headers.entries()]).toHaveLength(0);
	});

	it("parses a single Content-Type header", () => {
		const stdout = "Content-Type: text/plain\r\n\r\nhello";
		const result = parseOutput(stdout);
		expect(result.body).toBe("hello");
		expect(result.headers.get("Content-Type")).toBe("text/plain");
		expect(result.status).toBe(200);
	});

	it("parses multiple headers", () => {
		const stdout =
			"Content-Type: application/json\r\n" +
			"X-Foo: bar\r\n" +
			"\r\n" +
			'{"ok":true}';
		const result = parseOutput(stdout);
		expect(result.body).toBe('{"ok":true}');
		expect(result.headers.get("Content-Type")).toBe("application/json");
		expect(result.headers.get("X-Foo")).toBe("bar");
	});

	it("parses Status: header into response status", () => {
		const stdout = "Status: 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope";
		const result = parseOutput(stdout);
		expect(result.status).toBe(404);
		expect(result.body).toBe("nope");
		// Status: is a pseudo-header and must not leak into Headers.
		expect(result.headers.get("Status")).toBeNull();
	});

	it("accumulates duplicate Set-Cookie headers", () => {
		const stdout =
			"Set-Cookie: a=1\r\n" +
			"Set-Cookie: b=2\r\n" +
			"\r\n" +
			"body";
		const result = parseOutput(stdout);
		// Headers.append preserves all values; reading via getSetCookie:
		const cookies = result.headers.getSetCookie();
		expect(cookies).toEqual(["a=1", "b=2"]);
	});

	it("handles LF-only line endings", () => {
		const stdout = "Content-Type: text/plain\n\nbody";
		const result = parseOutput(stdout);
		expect(result.headers.get("Content-Type")).toBe("text/plain");
		expect(result.body).toBe("body");
	});
});

describe("buildEpilogue", () => {
	it("produces a valid PHP block that prints headers + body", () => {
		const src = buildEpilogue();
		expect(src.startsWith("<?php")).toBe(true);
		expect(src).toContain("ob_get_clean()");
		expect(src).toContain("headers_list()");
		expect(src).toContain("http_response_code()");
	});
});

describe("buildCapture", () => {
	it("installs an ob_start callback that pushes via workers_php_call", () => {
		const src = buildCapture();
		expect(src).toContain("ob_start(function");
		expect(src).toContain("\\workers_php_call('__set_capture'");
		expect(src).toContain("\\http_response_code()");
		expect(src).toContain("\\headers_list()");
		expect(src).toContain("return ''");
	});

	it("returns empty from the callback so nothing goes to stdout", () => {
		const src = buildCapture();
		// The response goes to JS via the bridge; writing it onward would
		// duplicate it into stdout.
		expect(src).toMatch(/return ''\s*;\s*\}\s*\)/);
	});
});

describe("makeCaptureSlot", () => {
	it("returns an empty slot + a bridge method that populates it", () => {
		const {slot, bridgeMethod} = makeCaptureSlot();
		expect(slot.value).toBeNull();
		const ok = bridgeMethod(
			302,
			[
				"Location: /next",
				"Content-Type: text/html; charset=utf-8",
				"Set-Cookie: a=1",
				"Set-Cookie: b=2",
			],
			"redirecting...",
		);
		expect(ok).toBe(true);
		expect(slot.value).not.toBeNull();
		expect(slot.value!.status).toBe(302);
		expect(slot.value!.headers.get("Location")).toBe("/next");
		expect(slot.value!.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(slot.value!.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		expect(slot.value!.body).toBe("redirecting...");
	});

	it("strips Status:-styled pseudo-headers", () => {
		const {slot, bridgeMethod} = makeCaptureSlot();
		bridgeMethod(
			400,
			["Status: 400 Bad Request", "Content-Type: text/html"],
			"bad",
		);
		expect(slot.value!.status).toBe(400);
		expect(slot.value!.headers.get("Status")).toBeNull();
		expect(slot.value!.headers.get("Content-Type")).toBe("text/html");
	});

	it("defaults non-numeric status to 200 and non-string body to empty", () => {
		const {slot, bridgeMethod} = makeCaptureSlot();
		bridgeMethod(
			"oops" as unknown as number,
			[],
			null as unknown as string,
		);
		expect(slot.value!.status).toBe(200);
		expect(slot.value!.body).toBe("");
	});
});

describe("buildShutdown (back-compat alias)", () => {
	it("returns the same source as buildCapture", () => {
		expect(buildShutdown()).toBe(buildCapture());
	});
});

describe("readCapture (legacy, $GLOBALS-based)", () => {
	it("returns null when the global is unset", async () => {
		const stub = {exec: async (_code: string) => "null"};
		const out = await readCapture(stub);
		expect(out).toBeNull();
	});

	it("parses status/headers/body from a populated global", async () => {
		const stub = {
			exec: async (_code: string) =>
				JSON.stringify({
					status: 302,
					headers: [
						"Location: /next",
						"Content-Type: text/html; charset=utf-8",
						"Set-Cookie: PHPSESSID=abc; path=/",
					],
					body: "redirecting...",
				}),
		};
		const out = await readCapture(stub);
		expect(out).not.toBeNull();
		expect(out!.status).toBe(302);
		expect(out!.headers.get("Location")).toBe("/next");
		expect(out!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(out!.headers.getSetCookie()).toEqual(["PHPSESSID=abc; path=/"]);
		expect(out!.body).toBe("redirecting...");
	});

	it("ignores Status:-styled pseudo-headers in the header list", async () => {
		const stub = {
			exec: async (_code: string) =>
				JSON.stringify({
					status: 400,
					headers: ["Status: 400 Bad Request", "Content-Type: text/html"],
					body: "bad",
				}),
		};
		const out = await readCapture(stub);
		expect(out!.status).toBe(400);
		expect(out!.headers.get("Status")).toBeNull();
		expect(out!.headers.get("Content-Type")).toBe("text/html");
	});

	it("defaults to 200 if status is missing", async () => {
		const stub = {
			exec: async (_code: string) =>
				JSON.stringify({headers: [], body: "hi"}),
		};
		const out = await readCapture(stub);
		expect(out!.status).toBe(200);
		expect(out!.body).toBe("hi");
	});

	it("returns null on malformed JSON", async () => {
		const stub = {exec: async (_code: string) => "not-json"};
		expect(await readCapture(stub)).toBeNull();
	});

	it("returns null when exec returns null/undefined/empty", async () => {
		expect(await readCapture({exec: async () => null})).toBeNull();
		expect(await readCapture({exec: async () => undefined})).toBeNull();
		expect(await readCapture({exec: async () => ""})).toBeNull();
	});
});

describe("buildPrelude state reset", () => {
	it("clears $_SESSION, response code, headers, and ob buffers", async () => {
		const req = new Request("https://example.com/");
		const src = (await buildPrelude(req)).phpSource;
		expect(src).toContain("$_SESSION = []");
		expect(src).toContain("@http_response_code(200)");
		expect(src).toContain("@header_remove");
		expect(src).toContain("@ob_end_clean");
	});
});
