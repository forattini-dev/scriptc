function store(object: unknown, key: string, value: unknown): unknown {
  return ((object as Record<string, unknown>)[key] = value);
}
function numeric(object: unknown): number {
  return ((object as Record<string, unknown>)["number"] = 7);
}
const object: unknown = JSON.parse("{}");
const child: unknown = JSON.parse('{"value":1}');
console.log(store(object, "child", child) === child);
console.log((object as Record<string, unknown>)["child"] === child);
console.log(numeric(object), (object as Record<string, unknown>)["number"]);
try { console.log(numeric(null)); }
catch (error) { console.log((error as Error).name, (error as Error).message); }
