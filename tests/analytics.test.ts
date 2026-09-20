import { describe, expect, it, vi } from "vitest";

import { analytics } from "../src/container";

describe("analytics", () => {
    it("forwards data points to the dataset", async () => {
        const writeDataPoint = vi.fn();
        const response = await analytics("WEATHER").handle(
            new Request("http://example.com/write", {
                body: JSON.stringify({
                    blobs: ["Portugal"],
                    doubles: [24.5],
                    index: "customer-1",
                }),
                method: "POST",
            }),
            { WEATHER: { writeDataPoint } } as never,
            {} as never,
        );

        expect(response.status).toBe(200);
        expect(writeDataPoint).toHaveBeenCalledWith({
            blobs: ["Portugal"],
            doubles: [24.5],
            indexes: ["customer-1"],
        });
    });

    it("defaults to empty arrays without an index", async () => {
        const writeDataPoint = vi.fn();
        await analytics("WEATHER").handle(
            new Request("http://example.com/write", {
                body: JSON.stringify({ doubles: [1] }),
                method: "POST",
            }),
            { WEATHER: { writeDataPoint } } as never,
            {} as never,
        );

        expect(writeDataPoint).toHaveBeenCalledWith({
            blobs: [],
            doubles: [1],
            indexes: [],
        });
    });

    it("404s outside /write", async () => {
        const response = await analytics("WEATHER").handle(
            new Request("http://example.com/other", { method: "POST" }),
            { WEATHER: { writeDataPoint: vi.fn() } } as never,
            {} as never,
        );

        expect(response.status).toBe(404);
    });
});
