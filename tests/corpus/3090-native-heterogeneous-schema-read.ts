// @rust-only
// @no-engine
type Flag = { kind: "boolean" } | { kind: "value"; coerce: (raw: string) => unknown };
const boolean = { kind: "boolean" as const };
const number = { kind: "value" as const, coerce: (raw: string) => Number(raw) };
const source = { enabled: boolean, count: number };
function read<Schema extends Record<string, Flag>>(schema: Schema, name: string): Flag | undefined {
  return schema[name];
}
function show(flag: Flag | undefined): void {
  if (flag === undefined) console.log("missing");
  else if (flag.kind === "boolean") console.log("boolean");
  else console.log("value", flag.coerce("42"));
}
show(read(source, "enabled"));
show(read(source, "count"));
show(read(source, "missing"));
const flag = read(source, "count");
number.coerce = (_raw: string) => 9;
show(flag);
console.log("identity", read(source, "count") === flag);
let order = "";
function object() { order += "o"; return source; }
function key() { order += "k"; source.count = { kind: "value", coerce: (_raw: string) => 7 }; return "count"; }
function ordered<Schema extends Record<string, Flag>>(get: () => Schema): Flag | undefined { return get()[key()]; }
show(ordered(object));
console.log("order", order);
export {};
