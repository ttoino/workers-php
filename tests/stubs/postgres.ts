interface UnsafeCall {
    params?: unknown[];
    sql: string;
}

export const captured: { calls: UnsafeCall[]; connectionString?: string } = {
    calls: [],
};

const postgres = (connectionString: string) => {
    captured.connectionString = connectionString;
    return {
        end: async () => {},
        unsafe: async (sql: string, params?: unknown[]) => {
            captured.calls.push({ params, sql });
            return Object.assign([{ id: 1 }], { count: 1 });
        },
    };
};

export default postgres;
