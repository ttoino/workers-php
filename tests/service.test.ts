import { describe, expect, it } from "vitest";

import { service } from "../src/container";

describe("service", () => {
    it("forwards method, path, query and body to the binding", async () => {
        let seen: Request | undefined;
        const target = {
            fetch: async (request: Request) => {
                seen = request;
                return new Response("from-service", { status: 201 });
            },
        };

        const response = await service("API").handle(
            new Request("http://example.com/users/1?expand=roles", {
                body: "payload",
                headers: { "X-Custom": "yes" },
                method: "PATCH",
            }),
            { API: target } as never,
            {} as never,
        );

        expect(response.status).toBe(201);
        expect(await response.text()).toBe("from-service");
        expect(seen?.method).toBe("PATCH");
        expect(new URL(seen?.url ?? "").pathname).toBe("/users/1");
        expect(new URL(seen?.url ?? "").search).toBe("?expand=roles");
        expect(seen?.headers.get("X-Custom")).toBe("yes");
        expect(await seen?.text()).toBe("payload");
    });

    it("maps the endpoint root to /", async () => {
        let seen: Request | undefined;
        await service("API").handle(
            new Request("http://example.com/"),
            {
                API: {
                    fetch: async (request: Request) => {
                        seen = request;
                        return new Response("ok");
                    },
                },
            } as never,
            {} as never,
        );

        expect(new URL(seen?.url ?? "").pathname).toBe("/");
    });
});
