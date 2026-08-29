// @dynamic
// Real-world shape: a readonly registry tuple validates every keyed value.
const COUNTER_NAMES = [
  "open_pull_requests",
  "open_issues",
  "merged_today",
] as const;

function isCounter(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function hasEveryCounter(counters: Record<string, unknown>): boolean {
  return COUNTER_NAMES.every((name) => isCounter(counters[name]));
}

console.log(hasEveryCounter({
  open_pull_requests: 2,
  open_issues: 4,
  merged_today: 1,
}));
console.log(hasEveryCounter({
  open_pull_requests: 2,
  open_issues: "four",
  merged_today: 1,
}));
