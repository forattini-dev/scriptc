// @dynamic
// Workspace packages increasingly publish erasable TypeScript source directly.
// Their generic result shape must remain readable across the module island.
import { parseFlags, type FlagSchema } from "typed-workspace-flags";

const FLAGS = {
  json: { kind: "boolean" },
} as const satisfies FlagSchema;

console.log(parseFlags(["--json"], FLAGS).values.json === true);
