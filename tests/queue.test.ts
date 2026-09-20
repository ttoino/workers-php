import { describe, expect, it, vi } from "vitest";

import { queue } from "../src/container";

const jsonRequest = (path: string, body: unknown) =>
    new Request(`http://example.com${path}`, {
        body: JSON.stringify(body),
        method: "POST",
    });

describe("queue", () => {
    it("sends a message with content type and delay", async () => {
        const send = vi.fn();
        const response = await queue("QUEUE").handle(
            jsonRequest("/send", {
                body: '{"job":1}',
                contentType: "json",
                delaySeconds: 30,
            }),
            { QUEUE: { send } } as never,
            {} as never,
        );

        expect(response.status).toBe(200);
        expect(send).toHaveBeenCalledWith('{"job":1}', {
            contentType: "json",
            delaySeconds: 30,
        });
    });

    it("defaults to text", async () => {
        const send = vi.fn();
        await queue("QUEUE").handle(
            jsonRequest("/send", { body: "raw" }),
            { QUEUE: { send } } as never,
            {} as never,
        );

        expect(send).toHaveBeenCalledWith("raw", {
            contentType: "text",
            delaySeconds: undefined,
        });
    });

    it("batches messages", async () => {
        const sendBatch = vi.fn();
        const response = await queue("QUEUE").handle(
            jsonRequest("/sendBatch", {
                messages: [
                    { body: "a", delaySeconds: 10 },
                    { body: "b", contentType: "json" },
                ],
            }),
            { QUEUE: { sendBatch } } as never,
            {} as never,
        );

        expect(response.status).toBe(200);
        expect(sendBatch).toHaveBeenCalledWith([
            { body: "a", contentType: "text", delaySeconds: 10 },
            { body: "b", contentType: "json", delaySeconds: undefined },
        ]);
    });

    it("wraps binding errors in the error envelope", async () => {
        const send = vi.fn().mockRejectedValue(new Error("quota"));
        const response = await queue("QUEUE").handle(
            jsonRequest("/send", { body: "x" }),
            { QUEUE: { send } } as never,
            {} as never,
        );

        expect(response.status).toBe(500);
        expect((await response.json()) as { error: string }).toEqual({
            error: "Error: quota",
        });
    });

    it("404s on unknown paths", async () => {
        const response = await queue("QUEUE").handle(
            jsonRequest("/other", {}),
            { QUEUE: { send: vi.fn() } } as never,
            {} as never,
        );

        expect(response.status).toBe(404);
    });
});
