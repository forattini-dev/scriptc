// @rust-only
// @no-engine
interface Operation { key: string; enabled: boolean; agents?: string[] }
function read(map: ReadonlyMap<string, Operation>, key: string): boolean {
  const operation = map.get(key);
  if (operation === undefined) { return false; }
  return operation.enabled;
}
function same(map: ReadonlyMap<string, Operation>): ReadonlyMap<string, Operation> { return map; }
const first: Operation = { key: "first", enabled: true, agents: ["codex", "claude"] };
const second: Operation = { key: "second", enabled: false };
const map = new Map<string, Operation>([["one", first], ["two", second], ["one", second]]);
const view: ReadonlyMap<string, Operation> = map;
console.log("readonly-map", view.size, read(view, "one"), read(view, "missing"), same(view) === map);
map.set("one", first);
const found = view.get("one");
console.log("identity", found === first, read(view, "one"), view.has("one"), view.has("missing"));
console.log("delete", map.delete("two"), map.delete("two"), view.size);
function mutate(map: Map<string, Operation>, value: Operation): Operation { map.set("inside", value); return value; }
map.set("outside", mutate(map, second));
console.log("reentrant", view.size, view.get("outside") === second, view.get("inside") === second);
map.clear();
console.log("clear", view.size, view.get("one") === undefined);
const numbers = new Map<number, string>([[-0, "zero"], [0, "overwritten"], [0 / 0, "nan"]]);
console.log("same-value-zero", numbers.size, numbers.get(0) === "overwritten", numbers.get(-0) === "overwritten", numbers.has(0 / 0));
numbers.set(0 / 0, "replaced");
console.log("nan-replaced", numbers.size, numbers.get(0 / 0) === "replaced", numbers.delete(0 / 0));
interface Profile { tools: Record<string, boolean>; agents?: string[]; apps?: string[]; groups: Record<string, string[] | undefined> }
function enabled(profile: Profile, name: string): boolean { return profile.tools[name] === true; }
function agentCount(profile: Profile): number {
  const agents = profile.agents;
  if (agents === undefined) { return -1; }
  return agents.length;
}
const profile: Profile = { tools: { mise: true, disabled: false }, agents: ["codex"], groups: { default: ["claude"], empty: [] } };
console.log("dictionary", enabled(profile, "mise"), enabled(profile, "disabled"), profile.tools["missing"] === undefined);
profile.tools["mise"] = false;
profile.tools.extra = true;
console.log("dictionary-set", enabled(profile, "mise"), enabled(profile, "extra"), profile.tools === profile.tools);
console.log("optional-array", agentCount(profile), profile.apps === undefined);
const saved = profile.agents;
console.log("array-identity", saved === profile.agents, saved === undefined);
profile.agents = undefined;
console.log("array-absent", agentCount(profile));
profile.agents = [];
console.log("array-empty", agentCount(profile));
profile.agents = ["new"];
console.log("array-present", agentCount(profile), saved === profile.agents);
const group = profile.groups["default"];
if (group !== undefined) { console.log("dictionary-array", group.length, group[0] === "claude"); }
console.log("dictionary-array-missing", profile.groups["missing"] === undefined);
profile.groups["later"] = ["codex", "other"];
const later = profile.groups.later;
if (later !== undefined) { console.log("dictionary-array-write", later.length, later[1] === "other"); }
function fallback(values: string[] = []): number { return values.length; }
console.log("array-default", fallback(), fallback(undefined), fallback(["x"]));
const unions = new Map<string, string | number>([["word", "hello"], ["number", 42]]);
console.log("union-value", unions.get("word") === "hello", unions.get("number") === 42, unions.get("missing") === undefined);
const optional = new Map<string, number | undefined>([["present", undefined], ["number", 0]]);
console.log("stored-undefined", optional.has("present"), optional.has("missing"), optional.get("present") === undefined, optional.get("number") === 0);
const arrayMap = new Map<string, string[]>([["agents", ["codex"]]]);
const arrayValue = arrayMap.get("agents");
if (arrayValue !== undefined) { console.log("map-array", arrayValue.length, arrayValue[0] === "codex"); }
