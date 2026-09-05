// A module the static tier cannot lower (Proxy has no static story):
// under --island-module it embeds as engine source instead. Its own
// imports keep the project's tsconfig "paths" aliases.
import { bracket } from "@/helper";
const target = { answer: 42 };
export const wrapped: { answer: number } = new Proxy(target, {});

export function tag(s: string): string {
  return bracket(`<${s}>`);
}
