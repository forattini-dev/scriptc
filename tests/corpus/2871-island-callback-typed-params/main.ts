// @dynamic
// @rust-only
// @island-module: ./events.ts
// Typed callback parameters the host bridge converts at call time:
// `Error | undefined` (the realm's Error copies out; undefined takes the
// unit arm), `unknown` (a handle inside the checked-dynamic value), and
// a bare `Error`.
import { parse, withPlain } from "./events.ts";

const calls = parse((err: Error | undefined, argv: unknown, out: string) => {
  console.log(err === undefined ? "no error" : `${err.name}: ${err.message}`, typeof argv, JSON.stringify(out));
});
console.log(calls);
console.log(withPlain((e: Error) => `${e.name}/${e.message.toUpperCase()}`));
