// @rust-only
// @no-engine
type BooleanFlag = { kind: "boolean"; aliases?: string[] };
type ValueFlag<T> = { kind: "value"; aliases?: string[]; coerce: (raw: string) => T };
type Flag = BooleanFlag | ValueFlag<unknown>;
type Schema = Record<string, Flag>;
const value: ValueFlag<number> = { kind: "value", aliases: ["n"], coerce: (raw: string) => Number(raw) };
const boolean: BooleanFlag = { kind: "boolean", aliases: ["b"] };
const source = { number: value, enabled: boolean };
let calls = 0;
function getSchema() { calls++; return source; }
function accept(schema: Schema): Schema { return schema; }
function show(schema: Schema): void {
  for (const [key, flag] of Object.entries(schema)) {
    if (flag.kind === "value") console.log(key, flag.coerce("42"), flag.aliases?.join(","));
    else console.log(key, flag.kind, flag.aliases?.join(","));
  }
}
function change(flag: { kind: string }, kind: string): void { flag.kind = kind; }
const view = accept(getSchema());
const opaque: unknown = source;
const checked = opaque as Schema;
console.log("outer identity", view === checked, calls);
show(view);
value.coerce = (_raw: string) => 7;
value.aliases?.push("v");
show(checked);
change(value, "boolean");
show(view);
change(value, "value");
const replacement: ValueFlag<number> = { kind: "value", coerce: (_raw: string) => 9 };
view.number = replacement;
console.log("replacement", source.number === replacement, checked.number === view.number);
source.number = value;
console.log("source write", view.number === checked.number);
show(view);
view.added = boolean;
console.log("keys", Object.keys(source).join(","));
export {};
