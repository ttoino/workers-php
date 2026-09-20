interface StubNamespace {
    get(id: unknown): { fetch: (request: Request) => Promise<Response> };
    idFromName?(name: string): unknown;
}

export class Container {
    defaultPort?: number;

    onError(): void {}

    onStop(): void {}
}

export const getContainer = (binding: StubNamespace, name?: string) =>
    binding.get(
        binding.idFromName
            ? binding.idFromName(name ?? "default")
            : (name ?? "default"),
    );
