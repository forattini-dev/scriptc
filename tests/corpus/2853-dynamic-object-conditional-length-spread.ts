// @dynamic
type OptionSpec =
  | { kind: "boolean"; aliases?: string[] }
  | { kind: "value"; aliases?: string[]; coerce: (raw: string) => unknown };

function option(name: string, spec: OptionSpec): any {
  return {
    type: "string",
    ...(name.length === 1 ? { short: name } : {}),
    ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
  };
}

console.log(
  String(option("o", { kind: "boolean" }).short),
  String(option("output", { kind: "boolean" }).short),
);
console.log(String(option("verbose", { kind: "boolean", aliases: ["v"] }).aliases[0]));
