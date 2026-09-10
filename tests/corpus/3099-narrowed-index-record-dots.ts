// @no-engine
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function inspect(value: unknown): void {
  if (!isRecord(value)) { console.log("not-record"); return; }
  console.log(value.version === 1, typeof value.label, value.missing === undefined);
  if (typeof value.label === "string") console.log(value.label.toUpperCase());
  if (isRecord(value.nested)) console.log(value.nested.count === 2);
}
inspect(JSON.parse('{"version":1,"label":"sample","nested":{"count":2}}'));
inspect(JSON.parse('{}'));
inspect(null);
inspect([1]);
let calls = 0;
function source(): Record<string, unknown> { calls++; return { version: 1 }; }
console.log(source().version === 1, calls);
