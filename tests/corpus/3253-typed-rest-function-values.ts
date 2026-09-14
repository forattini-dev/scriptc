// @no-engine
// @transform-types
// Typed rest values keep the same completed-array ABI as direct calls.
type Join = (prefix: string, ...items: readonly string[]) => string;
const join: Join = (prefix: string, ...items: readonly string[]): string => prefix + items.join("/");
function invoke(fn: Join): string { return fn("via:", "a", "b"); }
console.log(join("empty:"), join("one:", "x"), invoke(join));
const words: string[] = ["c", "d"];
console.log(join("spread:", "b", ...words, "e"));
function count(...items: number[]): number { items.push(99); return items.length; }
const countValue: (...items: number[]) => number = count;
const numbers: number[] = [1, 2];
console.log(countValue(), countValue(1), countValue(...numbers), numbers.length);
function factory(prefix: string): Join {
  return (label: string, ...items: readonly string[]): string => prefix + label + items.join("|");
}
console.log(factory("captured:")("", "x", "y"));

const report = (label: string = "default", ...items: string[]): string => label + ":" + items.join("+");
console.log(report(), report(undefined, "a"), report("custom", "b", "c"));
class Formatter {
  static format(...items: string[]): string { return items.join(";"); }
}
const format: (...items: string[]) => string = Formatter.format;
console.log(format(), format("a", "b"), format === Formatter.format);
const callbacks: Join[] = [join, factory("array:")];
console.log(callbacks[0]("f:", "a", "b"), callbacks[1]("g:", "c"));
const service: { run: Join } = { run: join };
console.log(service.run("field:", "x", "y"));
const mutable: string[] = ["before"];
function mutate(): string { mutable[0] = "after"; return "tail"; }
console.log(join("order:", ...mutable, mutate()), mutable[0]);
class Runner {
  run: Join = join;
  static run: Join = join;
}
console.log(new Runner().run("instance:", "a", "b"), Runner.run("static:", ...words));
// eslint-disable-next-line @typescript-eslint/no-namespace -- namespace calls are a compiler contract
namespace Native {
  export const run: Join = join;
}
console.log(Native.run("namespace:", ...words));
function generic<T>(...items: T[]): number { return items.length; }
const specialized: (...items: string[]) => number = generic;
console.log(specialized("a", "b", "c"));
let order = "";
function choose(): Join { order += "callee "; return join; }
function argument(): string { order += "argument"; return "value"; }
console.log(choose()("eval:", argument()), order);
