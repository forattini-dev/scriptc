export interface BooleanFlagSpec {
  kind: "boolean";
}

export type FlagSchema = Record<string, BooleanFlagSpec>;
type FlagValue<Spec> = Spec extends BooleanFlagSpec ? boolean : never;

export interface ParseFlagsResult<Schema extends FlagSchema> {
  values: { [Key in keyof Schema]?: FlagValue<Schema[Key]> };
}
