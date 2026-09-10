// @rust-only
// @no-engine
// Native map views preserve checked dictionary identity; C/LLVM still copy.
interface TelemetryEvent { collection: string; [key: string]: unknown }
interface SpoolEntry { event?: TelemetryEvent }
// Unknown-valued entries retain their referenced object. Mutating that value
// must reach the original map, while replacing a row's value changes no source.
const nested: Record<string, unknown> = { count: 7 };
const event: TelemetryEvent = { collection: "alias", nested };
function checkAlias(entry: SpoolEntry): void {
  const snapshot = Object.entries(entry.event ?? {});
  console.log("event values", JSON.stringify(Object.values(entry.event ?? {})));
  for (const pair of snapshot) {
    if (pair[0] === "nested") {
      const value = pair[1] as Record<string, unknown>;
      console.log("alias", value === nested);
      value.count = 8;
      pair[1] = "replacement";
    }
    console.log("snapshot entry", pair[0], pair[1]);
  }
  console.log("snapshot length", snapshot.length);
}
checkAlias({ event });
console.log("source", nested.count, JSON.stringify(event));
