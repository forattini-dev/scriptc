function parse<Schema extends Record<string, unknown>>(
  schema: Schema,
): { values: { [K in keyof Schema]?: Schema[K] }; positionals: string[] } {
  return { values: schema, positionals: [] };
}

const result = parse({ flag: true });
console.log(result.values.flag);
console.log(result.positionals.length);
