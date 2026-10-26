// @rust-only
// @no-engine
function pair(input: string): string {
  const left = /left=(\w+)/.exec(input)?.[1];
  const right = /right=(\w+)/.exec(input)?.[1];
  if (!(left && right)) return "missing";
  return left.toUpperCase() + ":" + right.toUpperCase();
}
console.log("pair", pair("left=one right=two"), pair("left=one"), pair("right=two"), pair("none"));
function fallback(input: string): boolean {
  const alias = /\[(.*)\]/.exec(input)?.[1];
  return !alias || alias.trim().length > 0;
}
console.log("or", fallback("[value]"), fallback("[ ]"), fallback("[]"), fallback("none"));
function nested(input: string): string {
  const alias = /\[(.*)\]/.exec(input)?.[1];
  if (!!!alias) return "missing";
  return alias.trim();
}
console.log("nested", nested("[value]"), nested("[]"), nested("none"));
