import { describe, expect, it, vi } from "vitest";

import { phpWorker } from "../src/worker";

const stubEnv = (containerFetch: ReturnType<typeof vi.fn>) =>
    ({
        CONTAINER: {
            get: () => ({ containerFetch }),
            idFromName: () => "id",
        },
    }) as never;

const run = (containerFetch: ReturnType<typeof vi.fn>) =>
    phpWorker({ container: "CONTAINER", schedule: true }).scheduled?.(
        {} as never,
        stubEnv(containerFetch),
        {} as never,
    );

describe("phpWorker schedule", () => {
    it("omits the handler when schedule is off", () => {
        expect(phpWorker({ container: "CONTAINER" }).scheduled).toBeUndefined();
    });

    it("posts to the schedule endpoint on the consume port", async () => {
        const containerFetch = vi
            .fn()
            .mockResolvedValue(new Response("ok", { status: 200 }));

        await run(containerFetch);

        const [request, port] = (containerFetch.mock.calls[0] ?? []) as [
            Request,
            number,
        ];
        expect(port).toBe(8081);
        expect(new URL(request.url).pathname).toBe("/schedule");
        expect(request.method).toBe("POST");
    });

    it("holds through the boot window until the container is ready", async () => {
        const containerFetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response("booting", {
                    headers: { "Retry-After": "1" },
                    status: 503,
                }),
            )
            .mockResolvedValueOnce(new Response("ok", { status: 200 }));

        await run(containerFetch);

        expect(containerFetch).toHaveBeenCalledTimes(2);
    });

    it("throws when the run fails", async () => {
        const containerFetch = vi
            .fn()
            .mockResolvedValue(new Response("boom", { status: 500 }));

        await expect(run(containerFetch)).rejects.toThrow("status 500");
    });
});
