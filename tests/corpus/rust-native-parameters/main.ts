// @rust-only
// @no-engine
function fallback(label: string, value: number): number {
  console.log(label);
  return value;
}
export function defaults(a: number = fallback("default-a", 10), b: number = a + 2): number {
  a = a + 1;
  return a * 100 + b;
}
console.log("omitted", defaults());
console.log("undefined", defaults(undefined, undefined));
console.log("supplied", defaults(0, 0));
console.log("argument-order", defaults(fallback("argument-a", 3), fallback("argument-b", 4)));
console.log("arguments-before-defaults", defaults(undefined, fallback("argument-before-default", 9)));
export function optional(value?: number): number {
  if (value === undefined) { return 99; }
  return value * 2;
}
console.log("optional", optional(), optional(undefined), optional(0), optional(4));
function nullable(value: string | null = "default"): boolean {
  return value === null;
}
console.log("null", nullable(), nullable(undefined), nullable(null), nullable(""));
function truth(value: boolean = true): boolean { return value; }
console.log("false", truth(), truth(undefined), truth(false));
function beforeRequired(a: number = 5, b: number): number { return a + b; }
console.log("before-required", beforeRequired(undefined, 2));
function counter(start: number = 10): () => number {
  return () => { start = start + 1; return start; };
}
const next = counter();
console.log("captured-default", next(), next());
function fresh(value: { count: number } = { count: 0 }): { count: number } {
  value.count = value.count + 1;
  return value;
}
const first = fresh();
const second = fresh(undefined);
console.log("fresh", first === second, first.count, second.count);
function blockScope(value: number = 6): number { { const value = 2; console.log("shadow", value); } return value; }
console.log("binding", blockScope());
