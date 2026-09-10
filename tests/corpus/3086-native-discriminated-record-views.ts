// @rust-only
// @no-engine
type BooleanFlag = { kind: "boolean"; aliases?: string[] };
type ValueFlag<T> = { kind: "value"; aliases?: string[]; coerce: (raw: string) => T };
type Flag = BooleanFlag | ValueFlag<unknown>;
const names = ["n"];
const source: ValueFlag<number> = { kind: "value", aliases: names, coerce: (raw: string) => Number(raw) };
const opaque: unknown = source;
const view = opaque as Flag;
function show(flag: Flag): void {
  if (flag.kind === "boolean") console.log("boolean", flag.aliases?.join(","));
  else console.log("value", flag.coerce("42"), flag.aliases?.join(","));
}
function change(value: { kind: string }, kind: string): void { value.kind = kind; }
show(source);
show(view);
change(source, "boolean");
show(view);
const second = opaque as Flag;
console.log("identity", view === second);
change(source, "value");
source.coerce = (_raw: string) => 7;
show(second);
let calls = 0;
function extra() { calls++; return { kind: "boolean" as const, aliases: ["b"], coerce: (_raw: string) => 99 }; }
show(extra());
console.log("calls", calls, names.join(","));
export {};
