export class Container {
    defaultPort?: number;

    onError(_error: unknown): void {}

    onStop(_stop: { exitCode: number; reason: string }): void {}
}

interface StubNamespace {
    get(id: unknown): { fetch: (request: Request) => Promise<Response> };
    idFromName?(name: string): unknown;
}

export const getContainer = (binding: StubNamespace, name?: string) =>
    binding.get(binding.idFromName ? binding.idFromName(name ?? "default") : (name ?? "default"));
