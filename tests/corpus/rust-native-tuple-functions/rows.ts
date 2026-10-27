// @rust-only
// @no-engine
export {};
type Budget = {high?: number; max?: number};
function account(budget: Budget): string {
  let high = 0;
  let max = 0;
  for (const [declared, add] of [
    [budget.high, (bytes: number) => high += bytes],
    [budget.max, (bytes: number) => max += bytes],
  ] as const) {
    if (declared == null) continue;
    add(declared);
  }
  return `${high}:${max}`;
}
console.log("budget", account({}), account({high: 2}), account({max: 4}), account({high: 0, max: 7}));

function present(input?: number): number {
  const [value] = [input] as const;
  if (null == value) return -1;
  return value + 1;
}
function inverse(input?: number): number {
  const [value] = [input] as const;
  if (!(value != null)) return -1;
  return value + 2;
}
console.log("guards", present(), present(0), inverse(), inverse(0));
function mutable(): number {
  let [value] = [2 as number | undefined] as const;
  const clear = (): void => { value = undefined; };
  if (value != null) {
    clear();
    return Math.max(0, value);
  }
  return -1;
}
console.log("invalidation", mutable());
