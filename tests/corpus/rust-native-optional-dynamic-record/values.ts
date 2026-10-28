// @rust-only
// @no-engine
export {};
function objectView(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
const data: any = JSON.parse('{"first":1,"nested":{"value":"ok"}}');
const view = objectView(data);
if (view !== undefined) {
  console.log("read", String(view["first"]), view === data);
  view["first"] = 7;
  console.log("write", String(data.first));
  const nested = objectView(view["nested"]);
  if (nested !== undefined) console.log("nested", String(nested["value"]));
}
console.log("absent", objectView(null) === undefined, objectView("text") === undefined);
const fixed = { first: "start" };
const fixedAlias: any = fixed;
const fixedView = objectView(fixed);
if (fixedView !== undefined) {
  fixedView["first"] = "changed";
  console.log("typed", fixedView === fixedAlias, fixed.first);
}
