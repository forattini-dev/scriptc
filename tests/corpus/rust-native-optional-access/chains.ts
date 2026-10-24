// @rust-only
// @no-engine
export {};
type Leaf = {value: number};
type Root = {child: Leaf | undefined};
let trace = "";
function leafKey(): string { trace = trace + "k"; return "value"; }
function read(root: Root | undefined): number | undefined { return root?.child?.value; }
console.log(read({child: {value: 6}}), read({child: undefined}), read(undefined));
type Table = Record<string, Record<string, Leaf>>;
function table(root: Table | null | undefined): number { return root?.["a"]?.["b"]?.value ?? 0; }
console.log(table({a: {b: {value: 8}}}), table({a: {}}), table({}), table(null));
// Dynamic payloads retain the observable difference between a skipped chain
// and a present object whose non-optional continuation reads a missing value.
function dynamic(value: any): void {
  trace = "";
  try { console.log(String(value?.child[leafKey()])); }
  catch (error) { console.log((error as Error).name); }
  console.log(trace);
  try { console.log(String((value?.child)[leafKey()])); }
  catch (error) { console.log((error as Error).name); }
  console.log(trace);
}
dynamic(undefined); dynamic({child: {value: 4}}); dynamic({});
const alias: Leaf = {value: 3};
const dictionary: Record<string, Leaf> = {saved: alias};
const result = dictionary?.["saved"];
console.log(result === alias);
// The receiver is statically nullish, so the key is skipped.
trace = "";
console.log(String(null?.[leafKey()]));
console.log(trace);
