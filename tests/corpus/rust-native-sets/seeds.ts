// @rust-only
// @no-engine
function seed(): number[] { console.log("seed once"); return [0 / 0, 0 / 0, -0, 0, 2, 2]; }
const set = new Set(seed());
console.log("numbers", set.size, set.has(0 / 0), set.has(-0), set.has(0), set.has(3));
console.log("nan deletion", set.delete(0 / 0), set.delete(0 / 0), set.size);
set.add(0 / 0);
console.log("reinsertion", set.size, set.has(0 / 0));
const values: string[] = ["a", "a", "b"];
const strings = new Set(values);
values.push("c");
console.log("seed snapshot", strings.size, strings.has("c"));
console.log("empty seeds", new Set<string>([]).size, new Set<string>(undefined).size, new Set<string>(null).size);
const aliases: Set<string>[] = [strings, strings];
console.log("aliases", aliases[0] === aliases[1], strings !== new Set(values));
