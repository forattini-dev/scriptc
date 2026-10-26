// @rust-only
// @no-engine
// @ts-nocheck
export {};
const convert: typeof Number = Number;
const alias = convert;
console.log("identity", convert === alias, alias === Number, alias !== String);
console.log("calls", alias("23"), convert(), alias.call(null, "31"), alias.apply(undefined, ["41"]));
const bound = alias.bind({ignored: true}, "51");
console.log("bound", bound(99), bound !== alias);
function apply(fn: typeof Number, value: unknown): number { return fn(value); }
console.log("callback", apply(alias, "61"), apply(Number, 71n));
function shadow(Number: (value: string) => number): number { return Number("local"); }
console.log("shadow", shadow((value: string): number => value === "local" ? 91 : 0));
