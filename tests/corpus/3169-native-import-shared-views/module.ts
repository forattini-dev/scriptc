export const nested = { child: { count: 0 } };
export const indexed: Record<string, number> = { count: 0 };
export function updateIndexed(value: Record<string, number>): void { value.count++; }
export function indexedState(): Record<string, number> { return indexed; }
export async function nestedState() { await Promise.resolve(); return nested; }
export async function append(value: { values: number[] }): Promise<void> {
  await Promise.resolve(); value.values.push(3);
}
export function increment(value: { count: number }): void { value.count++; }
