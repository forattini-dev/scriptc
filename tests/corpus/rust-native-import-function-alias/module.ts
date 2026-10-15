export type Row = { count: number };
export const shared: Row = { count: 1 };
export let calls = 0;
export function fresh(row: Row = { count: 0 }): Row { calls++; row.count++; return row; }
export function twice(row: Row = { count: 0 }): Row { calls++; row.count += 2; return row; }
export function array(values: number[] = []): number[] { values.push(7); return values; }
export async function later(row: Row = shared): Promise<Row> { return fresh(row); }
export function fail(): void { throw new Error("alias failure"); }
export default function named(row: Row = shared): Row { return twice(row); }
