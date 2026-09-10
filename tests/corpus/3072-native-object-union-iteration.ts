// @no-engine
interface TelemetryEvent {
  collection: string;
  count?: number;
  enabled?: boolean;
  [key: string]: unknown;
}
interface SpoolEntry { event?: TelemetryEvent }
function spoolRow(entry: SpoolEntry): Record<string, string | number | boolean | null> {
  const row: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(entry.event ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      row[key] = value;
    } else if (value !== undefined) {
      row[key] = JSON.stringify(value);
    }
  }
  return row;
}
console.log("row", JSON.stringify(spoolRow({ event: { collection: "test", count: 2, enabled: false, extra: null } })));
console.log("missing", JSON.stringify(spoolRow({})));

type Choice = { count: number } | { label: string };
let reads = 0;
function choose(text: boolean): Choice {
  reads++;
  return text ? { label: "alpha" } : { count: 42 };
}
function describe(text: boolean): void {
  const entries = Object.entries(choose(text));
  console.log("entries", JSON.stringify(entries), "reads", reads);
  for (const [key, value] of entries) {
    console.log("value", key, typeof value, typeof value === "string" ? value.toUpperCase() : value + 1);
  }
  console.log("keys", Object.keys(choose(text)).join(","), "reads", reads);
  console.log("values", JSON.stringify(Object.values(choose(text))), "reads", reads);
}
describe(false);
describe(true);

function genericEntries<T extends object>(value: T): void {
  for (const [key, item] of Object.entries(value)) console.log("generic", key, typeof item);
}
genericEntries({ count: 4 });
genericEntries({ name: "typed" });

console.log("empty", JSON.stringify(Object.values({})), Object.entries({}).length);
