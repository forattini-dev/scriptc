export type Row = { count: number; tags: string[]; values: Record<string, string | null> };
export const rows: Row[] = [{ count: 1, tags: ["first"], values: { nil: null, text: "old" } }];
export let current: Row | null | undefined = rows[0];
export let numbers: number[] = [1, 2];
export function same(input: Row[]): Row[] { return input; }
export function optional(input?: Row): Row | undefined { if (input) input.count++; return input; }
export function optionalArray(input?: Row[]): Row[] | undefined { return input; }
export function maybe(flag: boolean): Row | null { return flag ? rows[0]! : null; }
export async function later(flag: boolean): Promise<Row | null> { await Promise.resolve(); return maybe(flag); }
export async function laterArray(): Promise<Row[]> { await Promise.resolve(); return rows; }
export function replace(): void { numbers = [8]; current = null; }
export function clear(): void { current = undefined; }
export function restore(): void { current = rows[0]; }
export type Choice = { kind: "left"; count: number } | { kind: "right"; label: string };
export let choice: Choice | null = { kind: "left", count: 3 };
export function choose(input: Choice | null): Choice | null { choice = input; return input; }
export function empty(): null { return null; }
export const sparse = [1, , 3] as number[];
export function nullableArray(input: Row[] | null | undefined): Row[] | null | undefined { return input; }
