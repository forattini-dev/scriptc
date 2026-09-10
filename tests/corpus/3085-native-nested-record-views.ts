// @rust-only
// @no-engine
interface Leaf { aliases?: string[]; coerce: (raw: string) => number | undefined }
interface ViewLeaf { aliases?: string[]; coerce: (raw: string) => unknown }
interface Source { flag: Leaf; optional?: Leaf; pass: (leaf: Leaf | undefined) => Leaf | undefined }
interface View { flag: ViewLeaf; optional?: ViewLeaf; pass: (leaf: ViewLeaf | undefined) => ViewLeaf | undefined }
const names = ["n"];
const leaf: Leaf = { aliases: names, coerce: (raw: string): number | undefined => raw === "none" ? undefined : Number(raw) };
const source: Source = { flag: leaf, optional: leaf, pass: (leaf: Leaf | undefined): Leaf | undefined => leaf };
const boxed: unknown = source;
const view = boxed as View;
const original: unknown = leaf;
const nested: unknown = view.flag;
console.log("identity", original === nested, view.flag.aliases === names);
const returned: unknown = view.pass(view.flag);
console.log("pass", returned === original, view.pass(undefined) === undefined);
console.log("results", view.flag.coerce("42"), view.flag.coerce("none"));
const aliases = view.flag.aliases;
if (aliases !== undefined) aliases.push("nested");
console.log("mutation", names.join(","));
leaf.coerce = (_raw: string) => 9;
console.log("callback", view.flag.coerce("42"));
view.optional = undefined;
console.log("optional", source.optional === undefined);
source.flag = { aliases: ["new"], coerce: (_raw: string) => 7 };
console.log("replacement", view.flag.coerce("42"), view.flag.aliases?.join(","), names.join(","));
console.log("json", JSON.stringify(boxed));
interface Optional { flag?: Leaf }
const empty = JSON.parse("{}") as Optional;
console.log("json empty", empty.flag === undefined);
try { const invalid = JSON.parse('{"flag":{"aliases":["x"]}}') as Optional; invalid.flag?.coerce("1"); }
catch (error) { if (error instanceof TypeError) console.log("json callable", "rejected"); }
export {};
