// Runtime stand-ins for the cloudflare:workers module; types come from
// @cloudflare/workers-types' ambient module declaration.
export class DurableObject<E = unknown> {
    constructor(
        protected ctx: DurableObjectState,
        protected env: E,
    ) {}
}

export class WorkerEntrypoint<E = unknown, P = unknown> {
    constructor(
        protected ctx: { props: P } & ExecutionContext,
        protected env: E,
    ) {}
}
