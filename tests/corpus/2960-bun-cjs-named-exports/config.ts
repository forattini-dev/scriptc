// The island module: named imports from a CommonJS package whose export
// table Node's lexer cannot see but Bun exposes.
import { definitions, flatten, shorthands, defaults, extra } from "npm-cfg";

const guard = new Proxy({ on: true }, {});
export function describe(): string {
  const names = Object.keys(definitions).sort().join(",");
  return `${names} ${flatten({ b: 1, a: 2 })} ${shorthands.v[0]} ${defaults.registry} ${extra}${(guard as { on: boolean }).on ? "" : "?"}`;
}
