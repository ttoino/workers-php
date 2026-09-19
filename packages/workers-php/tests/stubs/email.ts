// Minimal stand-ins for the worker runtime modules vitest cannot resolve.

export class EmailMessage {
    constructor(
        public from: string,
        public raw: string,
        public to: string,
    ) {}
}
