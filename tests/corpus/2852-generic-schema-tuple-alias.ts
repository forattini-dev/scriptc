interface BooleanFlagSpec {
  kind: "boolean";
  aliases?: string[];
}

interface ValueFlagSpec<T> {
  kind: "value";
  aliases?: string[];
  coerce: (raw: string) => T;
}

type FlagSchema = Record<string, BooleanFlagSpec | ValueFlagSpec<unknown>>;

function aliasIndexOf(schema: FlagSchema): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, spec] of Object.entries(schema)) {
    index.set(name, name);
    for (const alias of spec.aliases ?? []) index.set(alias, name);
  }
  return index;
}

function resolveAlias<Schema extends FlagSchema>(schema: Schema, alias: string): string | undefined {
  return aliasIndexOf(schema).get(alias);
}

const HELP_FLAGS = {
  help: { kind: "boolean", aliases: ["h"] },
} as const satisfies FlagSchema;

console.log(resolveAlias(HELP_FLAGS, "h"));
