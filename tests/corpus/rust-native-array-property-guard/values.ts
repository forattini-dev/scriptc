// @rust-only
// @no-engine
export {};

type Context = { values?: string[] };

function normalize(ctx: Context): string {
  if (ctx.values === undefined) return "missing";
  const values = Array.isArray(ctx.values) ? ctx.values : [ctx.values];
  return values.map((value) => value.toUpperCase()).join("|");
}

console.log(normalize({}));
console.log(normalize({ values: [] }));
console.log(normalize({ values: ["a", "b"] }));

type CompositeContext = Context & { enabled: boolean };
function composite(ctx: CompositeContext): string {
  if (!ctx.enabled || ctx.values === undefined) return "disabled";
  const values = Array.isArray(ctx.values) ? ctx.values : [ctx.values];
  return values.join(",");
}

console.log(composite({ enabled: false, values: ["ignored"] }));
console.log(composite({ enabled: true }));
console.log(composite({ enabled: true, values: ["x", "y"] }));
