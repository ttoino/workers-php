import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "cloudflare:email": new URL(
                "./tests/stubs/email.ts",
                import.meta.url,
            ).pathname,
            "cloudflare:workers": new URL(
                "./tests/stubs/workers.ts",
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
