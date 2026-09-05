// The island module (Proxy has no static lowering); it re-exports its own
// namespace under a name, the barrel forwards both.
export * as Locale from "./inner.ts";
const table = new Proxy({ width: 3 }, {});
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
export function make(type: string): { type: string; data: string[] } {
  return { type, data: [type, String((table as { width: number }).width)] };
}
