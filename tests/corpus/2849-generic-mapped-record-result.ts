interface BooleanFlagSpec {
  kind: "boolean";
}

type FlagSchema = Record<string, BooleanFlagSpec>;
type FlagValue<Spec> = Spec extends BooleanFlagSpec ? boolean : never;

interface ParseFlagsResult<Schema extends FlagSchema> {
  values: { [Key in keyof Schema]?: FlagValue<Schema[Key]> };
}

function parseFlags<Schema extends FlagSchema>(schema: Schema): ParseFlagsResult<Schema> {
  const values: Record<string, unknown> = {};
  for (const [name] of Object.entries(schema)) values[name] = true;
  return { values } as ParseFlagsResult<Schema>;
}

const SCHEMA = {
  json: { kind: "boolean" },
} as const satisfies FlagSchema;

console.log(parseFlags(SCHEMA).values.json === true);
