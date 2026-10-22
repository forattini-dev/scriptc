// @rust-only
// @no-engine
function inspect(value: any): void {
  const and = value && "right";
  const or = value || "right";
  console.log("case", typeof and, `${JSON.stringify(and)}`, typeof or, `${JSON.stringify(or)}`);
}
inspect(undefined); inspect(null); inspect(false); inspect(0); inspect(-0); inspect(0 / 0);
inspect(""); inspect(true); inspect(1); inspect("ok"); inspect({v: 1}); inspect([1]);
inspect(() => 1); inspect(Symbol("key"));
function keep(left: number, right: number): number { return left && right; }
console.log("zero", 1 / keep(-0, 5), keep(0 / 0, 5));
