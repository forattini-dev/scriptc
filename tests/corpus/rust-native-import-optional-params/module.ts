export function greet(name?: string): string { return name === undefined ? "omitted" : "hello " + name; }
export function count(value?: number): number { return value === undefined ? -1 : value + 1; }
export function flag(value?: boolean): string { return value === undefined ? "missing" : value ? "yes" : "no"; }
export function nullable(value?: string | null): string { return value === undefined ? "missing" : value === null ? "null" : value; }
export function pair(required: string, suffix?: string): string { return required + (suffix ?? "!"); }
export function optionalBeforeRequired(first: string | undefined, second?: number): string { return (first ?? "empty") + ":" + (second ?? -1); }
export async function later(value?: string): Promise<string> { await Promise.resolve(); return value ?? "async omitted"; }
export function fail(value?: string): string { throw new Error(value ?? "sync omitted"); }
export async function reject(value?: string): Promise<string> { throw new Error(value ?? "async rejected"); }
export { greet as alias };
