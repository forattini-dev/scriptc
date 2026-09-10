// @no-engine
// @rust-only
interface SourceFlag {
  kind: string;
  pass: (values: string[] | undefined) => string[] | undefined;
  aliases: string[] | undefined;
  coerce: (raw: string) => number | undefined;
}
interface Flag {
  kind: string;
  pass: (values: string[] | undefined) => string[] | undefined;
  aliases?: string[];
  coerce: (raw: string) => unknown;
}
const names = ["n"];
const source: SourceFlag = {
  kind: "value", aliases: names,
  pass: (values: string[] | undefined): string[] | undefined => values,
  coerce: (raw: string): number | undefined => {
    if (raw === "none") return undefined;
    if (raw === "throw") throw new Error("coerce");
    return Number(raw);
  },
};
const opaque: unknown = source;
const view = opaque as Flag;
console.log("values", view.kind, view.coerce("42"), view.coerce("none"));
console.log("pass", view.pass(names) === names, view.pass(undefined) === undefined);
console.log("aliases", view.aliases === source.aliases);
const alias = view.aliases;
if (alias !== undefined) alias.push("extra");
console.log("mutation", names.join(","));
const original: unknown = source.coerce;
const adapted: unknown = view.coerce;
console.log("callable", original === adapted);
try { view.coerce("throw"); } catch (error) {
  if (error instanceof Error) console.log("throw", error.message);
}
source.coerce = (_raw: string) => 99;
console.log("replacement", view.coerce("42"));
view.aliases = undefined;
console.log("absent", source.aliases === undefined, names.join(","));
view.aliases = ["new"];
const replaced = source.aliases;
if (replaced !== undefined) console.log("new", replaced.join(","));
