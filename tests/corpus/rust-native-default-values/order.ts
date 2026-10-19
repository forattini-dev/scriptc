// @rust-only
// @no-engine
export {};
function missing(label: string): number | undefined { console.log(label); return undefined; }
function supplied(): number { console.log("argument"); return 4; }
function defaults(a: number | undefined = missing("default a"), b: number | undefined = a): void {
  console.log("body", typeof a, typeof b);
}
defaults();
defaults(undefined, supplied());
defaults(0, 0);
function broken(): number | undefined { console.log("default throws"); throw "failure"; }
function sync(value: number | undefined = broken()): void { console.log("wrong body"); }
try { sync(); } catch (error) { console.log("caught", error as string); }
async function prefix(value: number | undefined = missing("async default")): Promise<boolean> {
  console.log("async body", typeof value); return value === undefined;
}
prefix().then(value => { console.log("async done", value); });
console.log("after async call");

let choices = 0;
function choose(): boolean { choices = choices + 1; console.log("choose", choices); return choices === 1; }
function defined(value: number = choose() ? 5 : 6): number { return value; }
console.log("defined branches", defined(), defined(), defined(0), choices);
function possible(flag: boolean, value: number | undefined = flag ? 1 : undefined): string { return typeof value; }
console.log("possible branches", possible(true), possible(false), possible(true, 0));
