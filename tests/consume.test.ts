import { describe, expect, it, vi } from "vitest";

import { phpWorker } from "../src/worker";

interface StubMessage {
    ack: ReturnType<typeof vi.fn>;
    attempts: number;
    body: unknown;
    id: string;
    retry: ReturnType<typeof vi.fn>;
}

const stubMessage = (overrides: Partial<StubMessage> = {}): StubMessage => ({
    ack: vi.fn(),
    attempts: 1,
    body: '{"job":1}',
    id: "msg-1",
    retry: vi.fn(),
    ...overrides,
});

const stubEnv = (containerFetch: ReturnType<typeof vi.fn>) =>
    ({
        CONTAINER: {
            get: () => ({ containerFetch }),
            idFromName: () => "id",
        },
    }) as never;

const run = (
    containerFetch: ReturnType<typeof vi.fn>,
    messages: StubMessage[],
) =>
    phpWorker({ consume: true, container: "CONTAINER" }).queue?.(
        { messages } as never,
        stubEnv(containerFetch),
        {} as never,
    );

describe("phpWorker consume", () => {
    it("posts the message envelope to the consume port and acks a 200", async () => {
        const containerFetch = vi
            .fn()
            .mockResolvedValue(new Response("ok", { status: 200 }));
        const message = stubMessage();

        await run(containerFetch, [message]);

        const [request, port] = (containerFetch.mock.calls[0] ?? []) as [
            Request,
            number,
        ];
        expect(port).toBe(8081);
        expect(new URL(request.url).pathname).toBe("/consume");
        expect(await request.json()).toEqual({
            attempts: 1,
            body: '{"job":1}',
            id: "msg-1",
        });
        expect(message.ack).toHaveBeenCalled();
        expect(message.retry).not.toHaveBeenCalled();
    });

    it("retries a 500 honoring the X-Queue-Delay header", async () => {
        const containerFetch = vi.fn().mockResolvedValue(
            new Response("boom", {
                headers: { "X-Queue-Delay": "30" },
                status: 500,
            }),
        );
        const message = stubMessage();

        await run(containerFetch, [message]);

        expect(message.ack).not.toHaveBeenCalled();
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    });

    it("retries a 500 without a delay", async () => {
        const containerFetch = vi
            .fn()
            .mockResolvedValue(new Response("boom", { status: 500 }));
        const message = stubMessage();

        await run(containerFetch, [message]);

        expect(message.retry).toHaveBeenCalledWith(undefined);
    });

    it("retries when the container fetch throws", async () => {
        const containerFetch = vi
            .fn()
            .mockRejectedValue(new Error("not ready"));
        const message = stubMessage();

        await run(containerFetch, [message]);

        expect(message.retry).toHaveBeenCalled();
        expect(message.ack).not.toHaveBeenCalled();
    });

    it("processes every message in the batch independently", async () => {
        const containerFetch = vi
            .fn()
            .mockResolvedValueOnce(new Response("ok", { status: 200 }))
            .mockResolvedValueOnce(new Response("boom", { status: 500 }));
        const first = stubMessage({ id: "msg-1" });
        const second = stubMessage({ id: "msg-2" });

        await run(containerFetch, [first, second]);

        expect(first.ack).toHaveBeenCalled();
        expect(first.retry).not.toHaveBeenCalled();
        expect(second.ack).not.toHaveBeenCalled();
        expect(second.retry).toHaveBeenCalled();
    });
});
