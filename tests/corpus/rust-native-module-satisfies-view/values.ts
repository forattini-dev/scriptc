interface Policy {
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly targetRatio: number;
}

export const REGISTRY = {
  history: { maxBytes: 8 * 1024, maxAgeMs: 14, targetRatio: 0.75 },
  events: { maxBytes: 4 * 1024, targetRatio: 0.5 },
} as const satisfies Readonly<Record<string, Policy>>;

console.log(REGISTRY.history.maxBytes, REGISTRY.events.targetRatio);

const defaults = { headers: {} };
const headers = defaults.headers;
// @ts-expect-error JavaScript dependencies routinely add header expandos.
headers["user-agent"] = "scriptc";
console.log("header written");
