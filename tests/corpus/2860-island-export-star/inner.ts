// The island module (Proxy has no static lowering).
const state = new Proxy({ hits: 0 }, {});
export function hit(): number {
  state.hits += 1;
  return state.hits;
}
export function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
export const label = "inner";
