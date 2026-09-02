// @dynamic
// Agent-written CLIs commonly read a typed mapped result directly from a
// package helper instead of adding a local result assertion.
import { parseFlags, type FlagSchema } from "typed-flags";

const FLAGS = {
  json: { kind: "boolean" },
} as const satisfies FlagSchema;

const parsed = parseFlags(["--json", "run"], FLAGS);
console.log(parsed.values.json === true, parsed.positionals[0]);
