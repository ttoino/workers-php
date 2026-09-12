# php-wasm-worker

PHP 8.5 running on Cloudflare Workers, via [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm).

- `packages/workers-php/` — the `workers-php` npm library: runtime TS in `src/runtime/`, PHP runtime library in `php/`, wasm artifacts in `src/wasm/`, CLI in `bin/workers-php.mjs`, tests in `test/`.
- `build/` — wasm build from source: `build-php-wasm.sh` (docker, clones upstream at `pinned-commit.txt`, applies `patches/`, stages artifacts), `promote-wasm.sh`, extension config in `php-wasm.env`, vendored app overlays in `feup/`.
- `php/` + `src/index.ts` — root demo Worker.
- `examples/bindings-demo/` — D1/R2/KV bindings demo.
- `feup-ltw-proj/` — xaufome, cloned by `build-feup.sh` (not committed); deployed via `wrangler.feup.jsonc`.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | vitest in **watch mode** — use `npx vitest run` for a one-shot run |
| `npx tsc --noEmit` | Type-check. Authoritative: editor LSP shows false positives here (`Fetcher`, `ExecutionContext`, C/PHP overlays) |
| `npm run dev` / `npm run deploy` | Root demo |
| `npm run dev:bindings` / `npm run deploy:bindings` | Bindings demo |
| `npm run dev:feup` / `npm run deploy:feup` | xaufome deployment |
| `npm run build-wasm` | Rebuild `php-web.wasm` from source (docker, long); produces `*.staged` |
| `npm run wasm-promote` | Promote staged wasm artifacts to active, old to `*.legacy` |
| `npx wrangler dev` / `deploy` / `types` | Local dev / deploy / regenerate types after binding changes |

## Comment & doc style

- Comments are small and informative: at most 1–3 paragraphs of 1–3 lines each. Public-API docblocks follow the same cap.
- State rationale, constraints, and gotchas only. Never restate what the code shows; delete comments that narrate the next statement.
- No section banners or separator lines; identifier names carry the structure.
- Impersonal present tense. No first person in code comments, no ALL-CAPS emphasis, no jokes, no hedging.
- READMEs and user-facing docs keep a second-person instructional voice.
- Comments embedded in generated code (e.g. PHP injected into built Makefiles) ship per request; keep them minimal.

## Upstream contributions (seanmorris/php-wasm)

- PR branches live in the fork (`ttoino/php-wasm`, cloned at `~/Projects/github/ttoino/php-wasm`). Comments in them match the existing style of the file being patched, **not** the house style above — upstream `pib.c` comments are telegraphic fragments, `static.mak` files leave configure flags bare.
- Commit subjects: short sentence-case, no conventional-commit prefixes. PRs target `master`.
- `build/patches/` files are overlays of upstream sources: keep them in sync with the fork branch word-for-word, marking local additions with a `workers-php:` comment prefix. Do not fix pre-existing upstream typos in the fork; overlay-only fixes are fine.

## Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

### Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

### Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

### Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

### Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

### Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
