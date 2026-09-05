// The island module: a type-only specifier list — Bun drops the whole
// import, so the worker script never evaluates here.
import { type rpc } from "./worker.ts";
const guard = new Proxy({ on: true }, {});
export function describe(): string {
  const shape: rpc = { ping: () => "pong" };
  return `${shape.ping()}${(guard as { on: boolean }).on ? "" : "?"}`;
}
