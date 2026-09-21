// Consumers generate a global `Env` interface via `wrangler types`
// (worker-configuration.d.ts); declaration merging fills this empty
// interface with the app's real bindings, so library generics can
// default to it. Without generated types it stays empty and binding
// names fall back to plain strings.
declare global {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env {}
}

/** Env keys holding a Durable Object namespace, any container flavor. */
export type ContainerKey = keyof Env extends never
    ? string
    : {
          [K in keyof Env]: Env[K] extends
              | DurableObjectNamespace<Rpc.DurableObjectBranded>
              | DurableObjectNamespace<undefined>
              ? K
              : never;
      }[keyof Env] &
          string;

/** Env keys whose values match `T`, or `string` when no Env was generated. */
export type KeyOf<T> = keyof Env extends never
    ? string
    : {
          [K in keyof Env]: Env[K] extends T ? K : never;
      }[keyof Env] &
          string;
