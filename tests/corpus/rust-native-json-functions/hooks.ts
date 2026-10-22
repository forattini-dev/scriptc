// @rust-only
// @no-engine
let calls = 0;
let keySeen = "";
const hook = (key: string): string => { calls = calls + 1; keySeen = key; return "converted"; };
const value = {toJSON: hook};
const write = JSON.stringify;
console.log("hook", write({child: value}) === '{"child":"converted"}', calls === 1, keySeen === "child");
console.log("root-hook", write(value) === '"converted"', calls === 2, keySeen === "");
const shared = {value: 1};
console.log("shared", write({a: shared, b: shared}) === '{"a":{"value":1},"b":{"value":1}}');
interface Link { name: string; next?: Link }
const cycle: Link = {name: "loop"};
cycle.next = cycle;
try { write(cycle); } catch (error) { console.log("cycle", error instanceof TypeError, (error as Error).message); }
console.log("after", write({ok: true}) === '{"ok":true}');
