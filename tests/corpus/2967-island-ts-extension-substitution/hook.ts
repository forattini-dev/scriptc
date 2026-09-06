// The island module (Proxy keeps it there): a NodeNext-style import —
// the specifier says `.js`, the file on disk is `.ts` — the shape of a
// TypeScript project whose modules land in the island.
import { describeRuntime } from "./runtime.js";

const guard = new Proxy({ on: true }, {});
export function hook(name: string): string {
  return describeRuntime(name) + ((guard as { on: boolean }).on ? "" : "?");
}
