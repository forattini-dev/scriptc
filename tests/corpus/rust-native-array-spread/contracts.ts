// @rust-only
// @no-engine
import { companions } from "./source.ts";
const names = new Set(["core", "dev", ...companions("dev"), "core"]);
console.log(names.size, names.has("core"), names.has("dev-a"), names.has("dev-b"), names.has("missing"));
const source: string[] = ["a", "b"];
const copy = ["start", ...source, ...[], "end", ...["tail"]];
source.push("later");
console.log(copy.join("/"));
console.log(source.length);
const numbers: number[] = [0 / 0, -0, 4];
const seen = new Set([0, ...numbers, 4, ...[1, 2]]);
console.log(seen.size, seen.has(0 / 0), seen.has(0), seen.has(-0), seen.has(2));
const tuple = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] as const;
const empty = [] as const;
const positions = [...empty, ...tuple, "12"];
console.log(positions.join(","));
function fallback(value: number[] | undefined): number[] { return [...(value ?? []), 9]; }
console.log(fallback(undefined).join(","));
console.log(fallback([2, 3]).join(","));
function choose(value: number[] | undefined): number[] { return value ?? []; }
console.log(choose(numbers) === numbers, choose(undefined).length);
const entries: [string, number][] = [["one", 1]];
const indexed = new Map<string, number>([...entries, ["two", 2], ["one", 3]]);
console.log(indexed.size, indexed.get("one"), indexed.get("two"));
