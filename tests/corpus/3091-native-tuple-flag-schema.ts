// @rust-only
// @no-engine
type Flag = { kind: "boolean"; aliases?: string[] } | { kind: "value"; aliases?: string[]; coerce: (raw: string) => unknown };
const aliases: [string, string] = ["f", "field"];
const source = { field: { kind: "value" as const, aliases, coerce: (raw: string) => raw } };
function accept(schema: Record<string, Flag>): Record<string, Flag> { return schema; }
const schema = accept(source);
const flag = schema.field;
const names = flag.aliases!;
console.log("identity", names === aliases);
names[0] = "F";
aliases[1] = "FIELD";
console.log("fields", names.join(","), aliases.join(","));
names.push("added");
console.log("length", aliases.length, names.length);
console.log("join", aliases.join(","));
const index: number = 2;
console.log("index", aliases[index]);
const copied = [...aliases];
copied[0] = "copy";
console.log("spread", copied.join(","), aliases[0]);
let count = 0;
for (const item of aliases) {
  console.log("item", item);
  if (count === 0) { names[1] = "changed"; names.push("last"); }
  count++;
}
console.log("iterations", count);
const [first, ...rest] = aliases;
console.log("rest", first, rest.join(","));
console.log("json", JSON.stringify(aliases));
export {};
