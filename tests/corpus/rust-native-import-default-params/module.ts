export type Row = { count: number };
export const sharedRow: Row = { count: 1 };
export let fallback = "before";
export const trace: string[] = [];
export let bodyStarts = 0;
function next(label: string): number { trace.push(label); return trace.length; }
function fail(): number { trace.push("throw"); throw new Error("default failed"); }
export function reset(): void { trace.length = 0; }
export function replace(): void { fallback = "after"; }
export function scalar(value: string | null = fallback): string { return `${value}`; }
export function number(value = 7): number { return value; }
export function boolean(value = true): boolean { return value; }
export function optional(first: string, last?: string): string { return first + (last ?? "missing"); }
export function tail(first: string, last = fallback): string { return first + last; }
export function middle(first = fallback, last: string): string { return first + last; }
export function overloaded(): string;
export function overloaded(value: string): string;
export function overloaded(value = "overload"): string { return value; }
export function ordered(first = next("first"), second = first + next("second")): string { return `${first}:${second}`; }
export function argument(): number { return next("argument"); }
export function fresh(row: Row = { count: 0 }): Row { row.count++; return row; }
export function destructured({ count }: Row = { count: 5 }): number { return count; }
export function shared(row: Row = sharedRow): Row { row.count++; return row; }
export function array(values: number[] = []): number[] { values.push(1); return values; }
export function throwing(value: number = fail()): number { bodyStarts++; return value; }
export async function later(value = next("async")): Promise<number> { return value; }
export async function laterThrowing(value: number = fail()): Promise<number> { bodyStarts++; return value; }
export default function namedDefault(value = "named"): string { return value; }
