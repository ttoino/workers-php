import {describe, it, expect, beforeAll, afterAll} from "vitest";
import {fetchMock} from "cloudflare:test";
import {createPhpHandler} from "../src/index";
import {makePhpApp, mockCtx} from "./helpers";

describe("curl polyfill (http_fetch bridge)", () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterAll(() => {
		fetchMock.deactivate();
	});

	it("curl_exec with CURLOPT_RETURNTRANSFER returns the body; getinfo reports status + content type", async () => {
		fetchMock
			.get("https://api.workers-php.test")
			.intercept({path: "/data", method: "GET"})
			.reply(200, '{"hello":"world"}', {
				headers: {"Content-Type": "application/json"},
			});

		const {env} = makePhpApp(
			"<?php\n" +
				"header('Content-Type: text/plain');\n" +
				"$ch = curl_init('https://api.workers-php.test/data');\n" +
				"curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n" +
				"$body = curl_exec($ch);\n" +
				"echo 'errno=' . curl_errno($ch) . ';';\n" +
				"echo 'body=' . $body . ';';\n" +
				"echo 'code=' . curl_getinfo($ch, CURLINFO_HTTP_CODE) . ';';\n" +
				"echo 'ct=' . curl_getinfo($ch, CURLINFO_CONTENT_TYPE) . ';';\n" +
				"curl_close($ch);\n",
		);
		const handler = createPhpHandler({
			appRoot: "/persist/test-curl-get",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(new Request("https://example.com/"), env, mockCtx);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("errno=0;");
		expect(body).toContain('body={"hello":"world"};');
		expect(body).toContain("code=200;");
		expect(body).toContain("ct=application/json;");
	}, 60000);

	it("sends POST method, headers, and urlencoded fields", async () => {
		fetchMock
			.get("https://api.workers-php.test")
			.intercept({path: "/submit", method: "POST"})
			.reply((opts) => ({
				statusCode: 201,
				data: JSON.stringify({
					method: opts.method,
					auth: opts.headers?.authorization ?? opts.headers?.Authorization ?? null,
					body: opts.body ?? null,
				}),
			}));

		const {env} = makePhpApp(
			"<?php\n" +
				"header('Content-Type: text/plain');\n" +
				"$ch = curl_init();\n" +
				"curl_setopt_array($ch, [\n" +
				"    CURLOPT_URL => 'https://api.workers-php.test/submit',\n" +
				"    CURLOPT_POST => true,\n" +
				"    CURLOPT_POSTFIELDS => ['a' => 'b', 'c' => 'd'],\n" +
				"    CURLOPT_HTTPHEADER => ['Authorization: Bearer tok123'],\n" +
				"    CURLOPT_RETURNTRANSFER => true,\n" +
				"]);\n" +
				"echo curl_exec($ch);\n",
		);
		const handler = createPhpHandler({
			appRoot: "/persist/test-curl-post",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(new Request("https://example.com/"), env, mockCtx);
		expect(res.status).toBe(200);
		const echoed = await res.text();
		expect(echoed).toContain('"method":"POST"');
		expect(echoed).toContain('"auth":"Bearer tok123"');
		expect(echoed).toContain('"body":"a=b&c=d"');
	}, 60000);

	it("maps network failure to CURLE_COULDNT_CONNECT and false", async () => {
		fetchMock
			.get("https://api.workers-php.test")
			.intercept({path: "/down", method: "GET"})
			.replyWithError(new TypeError("connect ECONNREFUSED"));

		const {env} = makePhpApp(
			"<?php\n" +
				"header('Content-Type: text/plain');\n" +
				"$ch = curl_init('https://api.workers-php.test/down');\n" +
				"curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n" +
				"$r = curl_exec($ch);\n" +
				"echo 'r=' . var_export($r, true) . ';';\n" +
				"echo 'errno=' . curl_errno($ch) . ';';\n" +
				"echo 'err=' . (curl_error($ch) !== '' ? 'set' : 'empty') . ';';\n",
		);
		const handler = createPhpHandler({
			appRoot: "/persist/test-curl-err",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(new Request("https://example.com/"), env, mockCtx);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("r=false;");
		expect(body).toContain("errno=7;");
		expect(body).toContain("err=set;");
	}, 60000);

	it("echoes the body instead of returning it when RETURNTRANSFER is off", async () => {
		fetchMock
			.get("https://api.workers-php.test")
			.intercept({path: "/page", method: "GET"})
			.reply(200, "page-content");

		const {env} = makePhpApp(
			"<?php\n" +
				"$ch = curl_init('https://api.workers-php.test/page');\n" +
				"$r = curl_exec($ch);\n" +
				"echo '|ret=' . var_export($r, true);\n",
		);
		const handler = createPhpHandler({
			appRoot: "/persist/test-curl-echo",
			docroot: ".",
			entrypoint: "index.php",
		});
		const res = await handler(new Request("https://example.com/"), env, mockCtx);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("page-content|ret=true");
	}, 60000);
});
