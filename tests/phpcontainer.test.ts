import { describe, expect, it, vi } from "vitest";

import {
    d1,
    PhpContainer,
    phpContainerPortHeader,
    phpOutbound,
    PhpOutbound,
} from "../src/container";

interface MockContainer {
    getTcpPort: ReturnType<typeof vi.fn>;
    images: Record<string, string>;
    interceptOutboundHttp: ReturnType<typeof vi.fn>;
    monitor: ReturnType<typeof vi.fn>;
    running: boolean;
    setInactivityTimeout: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
}

const mockContainer = (
    overrides: Partial<MockContainer> = {},
): MockContainer => ({
    getTcpPort: vi.fn((port: number) => ({
        fetch: vi.fn(
            async (request: Request) =>
                new Response(
                    `port:${port} header:${request.headers.get(phpContainerPortHeader)}`,
                ),
        ),
    })),
    images: { app: "registry.cloudflare.com/acct/app@sha256:1" },
    interceptOutboundHttp: vi.fn().mockResolvedValue(undefined),
    monitor: vi.fn().mockReturnValue(new Promise(() => undefined)),
    running: false,
    setInactivityTimeout: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    ...overrides,
});

const mockCtx = (
    container: MockContainer,
    exports: Record<string, unknown> = {},
) => ({
    blockConcurrencyWhile: (promise: () => Promise<unknown>) => promise(),
    container,
    exports,
    waitUntil: vi.fn(),
});

class TestContainer extends PhpContainer {
    envVars = { APP_KEY: "secret", UNSET: undefined };
}

describe("PhpContainer", () => {
    it("starts the container on the first request with the configured image and env", async () => {
        const container = mockContainer();
        const stub = new TestContainer(mockCtx(container) as never, {});

        const response = await stub.fetch(new Request("http://x.dev/login"));

        expect(container.start).toHaveBeenCalledWith({
            enableInternet: true,
            entrypoint: undefined,
            env: { APP_KEY: "secret" },
            image: "registry.cloudflare.com/acct/app@sha256:1",
            instance: "lite",
        });
        expect(container.setInactivityTimeout).toHaveBeenCalledWith(600_000);
        expect(container.monitor).toHaveBeenCalled();
        expect(await response.text()).toBe("port:8080 header:null");
    });

    it("does not restart a running container", async () => {
        const container = mockContainer({ running: true });
        const stub = new TestContainer(mockCtx(container) as never, {});

        await stub.fetch(new Request("http://x.dev/login"));

        expect(container.start).not.toHaveBeenCalled();
    });

    it("re-arms the inactivity timeout when constructed over a running container", async () => {
        const container = mockContainer({ running: true });

        new TestContainer(mockCtx(container) as never, {});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(container.setInactivityTimeout).toHaveBeenCalledWith(600_000);
        expect(container.monitor).toHaveBeenCalled();
    });

    it("re-registers intercepts when constructed over a running container", async () => {
        const proxy = { fetch: vi.fn() };
        const factory = vi.fn().mockReturnValue(proxy);
        TestContainer.outboundByHost = phpOutbound(d1("DB"));
        try {
            const container = mockContainer({ running: true });

            new TestContainer(
                mockCtx(container, { PhpOutbound: factory }) as never,
                {},
            );
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(container.interceptOutboundHttp).toHaveBeenCalledWith(
                "example.com",
                proxy,
            );
        } finally {
            TestContainer.outboundByHost = undefined;
        }
    });

    it("routes internal requests to the header port and strips the header", async () => {
        const container = mockContainer({ running: true });
        const stub = new TestContainer(mockCtx(container) as never, {});

        const response = await stub.fetch(
            new Request("http://container/schedule", {
                headers: { [phpContainerPortHeader]: "8081" },
                method: "POST",
            }),
        );

        expect(await response.text()).toBe("port:8081 header:null");
    });

    it("throws for an image missing from the images map", async () => {
        const container = mockContainer({ images: {} });
        const stub = new TestContainer(mockCtx(container) as never, {});

        await expect(
            stub.fetch(new Request("http://x.dev/login")),
        ).rejects.toThrow('workers-php: no image named "app"');
    });

    it("registers an intercept per outboundByHost host with the loopback props", async () => {
        const proxy = { fetch: vi.fn() };
        const factory = vi.fn().mockReturnValue(proxy);
        TestContainer.outboundByHost = phpOutbound(d1("DB"));
        try {
            const container = mockContainer();
            const stub = new TestContainer(
                mockCtx(container, { PhpOutbound: factory }) as never,
                {},
            );

            await stub.fetch(new Request("http://x.dev/login"));

            expect(container.interceptOutboundHttp).toHaveBeenCalledWith(
                "example.com",
                proxy,
            );
            expect(factory).toHaveBeenCalledWith({
                props: { className: "TestContainer", host: "example.com" },
            });
        } finally {
            TestContainer.outboundByHost = undefined;
        }
    });

    it("throws a clear error when PhpOutbound is not exported", async () => {
        TestContainer.outboundByHost = phpOutbound(d1("DB"));
        try {
            const container = mockContainer();
            const stub = new TestContainer(mockCtx(container) as never, {});

            await expect(
                stub.fetch(new Request("http://x.dev/login")),
            ).rejects.toThrow(
                'workers-php: export PhpOutbound from "workers-php" in your worker entrypoint',
            );
        } finally {
            TestContainer.outboundByHost = undefined;
        }
    });

    it("proxies https requests over plain http", async () => {
        const seen: string[] = [];
        const container = mockContainer({
            getTcpPort: vi.fn(() => ({
                fetch: vi.fn(async (request: Request) => {
                    seen.push(request.url);
                    return new Response("ok");
                }),
            })),
            running: true,
        });
        const stub = new TestContainer(mockCtx(container) as never, {});

        await stub.fetch(new Request("https://x.dev/login?next=1"));

        expect(seen).toEqual(["http://x.dev/login?next=1"]);
    });

    it("answers the boot gate while the port comes up", async () => {
        const container = mockContainer({
            getTcpPort: vi.fn(() => ({
                fetch: vi
                    .fn()
                    .mockRejectedValue(
                        new Error("Container is not listening to port 8080"),
                    ),
            })),
            running: true,
        });
        const stub = new TestContainer(mockCtx(container) as never, {});

        const response = await stub.fetch(new Request("http://x.dev/login"));

        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
    });

    it("rethrows port errors that are not the boot race", async () => {
        const container = mockContainer({
            getTcpPort: vi.fn(() => ({
                fetch: vi.fn().mockRejectedValue(new Error("boom")),
            })),
            running: true,
        });
        const stub = new TestContainer(mockCtx(container) as never, {});

        await expect(
            stub.fetch(new Request("http://x.dev/login")),
        ).rejects.toThrow("boom");
    });

    it("logs the exit code when the container stops", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = Object.assign(new Error("exited"), { exitCode: 3 });
        const container = mockContainer({
            monitor: vi.fn().mockRejectedValue(error),
            running: true,
        });

        new TestContainer(mockCtx(container) as never, {});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(console.log).toHaveBeenCalledWith(
            "container stopped: code=3 reason=exited",
        );
    });
});

describe("PhpOutbound", () => {
    it("dispatches intercepted requests to the class handler for the host", async () => {
        const prepare = vi.fn().mockReturnValue({
            all: vi.fn().mockResolvedValue({ results: [] }),
        });
        TestContainer.outboundByHost = phpOutbound(d1("DB"));
        try {
            const entrypoint = new PhpOutbound(
                {
                    props: { className: "TestContainer", host: "example.com" },
                } as never,
                { DB: { prepare } } as never,
            );

            const response = await entrypoint.fetch(
                new Request("http://example.com/DB/query", {
                    body: JSON.stringify({ sql: "SELECT 1" }),
                    method: "POST",
                }),
            );

            expect(response.status).toBe(200);
            expect(prepare).toHaveBeenCalledWith("SELECT 1");
        } finally {
            TestContainer.outboundByHost = undefined;
        }
    });

    it("answers 500 when the class registered no handler for the host", async () => {
        const entrypoint = new PhpOutbound(
            { props: { className: "Unknown", host: "example.com" } } as never,
            {} as never,
        );

        const response = await entrypoint.fetch(
            new Request("http://example.com/DB/query", { method: "POST" }),
        );

        expect(response.status).toBe(500);
    });
});
