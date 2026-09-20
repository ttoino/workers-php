import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@cloudflare/containers": new URL(
                "./tests/stubs/containers.ts",
                import.meta.url,
            ).pathname,
            "cloudflare:email": new URL(
                "./tests/stubs/email.ts",
                import.meta.url,
            ).pathname,
            postgres: new URL("./tests/stubs/postgres.ts", import.meta.url)
                .pathname,
        },
    },
    test: {
        include: ["tests/**/*.test.ts"],
    },
});
