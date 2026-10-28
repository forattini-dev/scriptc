// @rust-only
// @no-engine
function run(): number {
  let total = 0;
  const visit = (value: number, depth = 0): number => {
    total = total + 1;
    if (value === 0) return depth;
    return ((next: number): number => visit(next, depth + 1))(value - 1);
  };
  const alias = visit;
  console.log("identity", alias === visit);
  return alias(3) + total;
}
console.log("result", run());
