type Bag = Record<string, unknown>;
export function echo(value: unknown): unknown { return value; }
export async function increment(value: unknown): Promise<number> {
  const record = value as Bag;
  await Promise.resolve();
  record.count = (record.count as number) + 1;
  return record.count as number;
}
export let state: Bag = { count: 40 };
export function bump(): void { state.count = (state.count as number) + 1; }
export function currentCount(): number { return state.count as number; }
export function replace(): void { state = { count: 90 }; }
export { state as aliasState };
export default state;
