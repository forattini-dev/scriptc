interface BooleanFlagSpec {
  kind: "boolean";
  aliases?: string[];
}

interface ValueFlagSpec {
  kind: "value";
  coerce: (raw: string) => unknown;
}

type FlagSchema = Record<string, BooleanFlagSpec | ValueFlagSpec>;

const HELP_FLAGS = {
  help: { kind: "boolean", aliases: ["h"] },
} as const satisfies FlagSchema;

console.log(HELP_FLAGS.help.kind, HELP_FLAGS.help.aliases[0]);
