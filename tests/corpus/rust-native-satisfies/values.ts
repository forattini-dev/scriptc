// @rust-only
// @no-engine
const original = { required: "yes", extra: "keep" };
const checked = original satisfies { required: string };
console.log("identity", checked === original, checked.extra, Object.keys(checked).join("|"));
checked.extra = "changed";
console.log("alias", original.extra);
function add(value: number): number { return value + 1; }
const callback = add satisfies (value: number) => number;
console.log("function", callback === add, callback(4));
const tuple = ["native", 3] as const satisfies readonly [string, number];
console.log("tuple", tuple[0], tuple[1]);
const yes = true satisfies boolean;
console.log("primitive", yes, (4 satisfies number) + 2, ("word" satisfies string));
