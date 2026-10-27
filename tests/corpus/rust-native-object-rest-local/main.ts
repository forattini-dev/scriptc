// @rust-only
// @no-engine
export {};
let calls = 0;
function source() { calls++; return { remove: "x", keep: "yes", count: 2 }; }
const original = source();
const { remove: renamed, ...remaining } = original;
console.log("record", calls, renamed, remaining.keep, remaining.count, Object.keys(remaining).join("|"));
remaining.keep = "changed";
console.log("fresh", original.keep, remaining.keep);
const dynamic: any = JSON.parse('{"drop":1,"nested":{"x":2},"keep":3}');
const { drop, ...rest } = dynamic;
dynamic.keep = 4;
console.log("dynamic", drop === 1, rest.keep === 3, rest.nested === dynamic.nested, Object.keys(rest).join("|"));
function take(options: any) {
  const { reviver, ...streamOptions } = options ?? {};
  console.log("optional", reviver === undefined, streamOptions.keep === 3);
}
take(dynamic);
take(null);

const { remove: second, ...again } = source();
console.log("once", calls, second, again.keep);
try {
  const absent: any = null;
  const { x, ...tail } = absent;
  console.log(x === 0, tail === null);
} catch { console.log("null throws"); }

const tricky: any = JSON.parse('{"__proto__":"own","10":2,"2":1,"skip":9}');
const { skip, ...ordered } = tricky;
console.log("keys", skip === 9, Object.keys(ordered).join("|"), ordered["__proto__"] === "own");
