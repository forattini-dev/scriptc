// @dynamic
// Agent-written CLIs commonly pass a typed schema containing coercion callbacks
// into a dynamically loaded argument parser.
import { parseFlags } from "tiny-flags";

const FLAGS = {
  mode: { kind: "value", coerce: (raw: string) => raw.toUpperCase() },
  project: { kind: "value", coerce: (raw: string) => raw.toUpperCase() },
  verbose: { kind: "boolean" },
} as const;

interface ParsedFlags {
  values: { mode?: string; project?: string; verbose?: boolean };
  positionals: string[];
}

const { values, positionals } = parseFlags(
  ["--mode", "global", "--project", "scriptc", "--verbose", "tail"],
  FLAGS,
) as ParsedFlags;

console.log(values.mode, values.project, values.verbose, positionals[0]);
