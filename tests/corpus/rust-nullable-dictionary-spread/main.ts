// @rust-only
// @no-engine
type BindingMap = Record<string, string | null>;
type Entry = { context?: string; bindings?: BindingMap } & Record<string, unknown>;
type Config = { bindings?: Entry[]; metadata?: { count: number } } & Record<string, unknown>;

function render(value: string | null | undefined): string {
  return value === undefined ? "absent" : value === null ? "null" : value;
}
const input: unknown = JSON.parse('{"extra":{"count":1},"metadata":{"count":2},"2":"two","bindings":[{"context":"Chat","bindings":{"keep":"old","nil":null},"other":true}],"tail":9}');
if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("object required");
const config = input as Config;
const entries = config.bindings ?? [];
const entry = entries[0]!;
const current = entry.bindings ?? {};
for (const key of ["keep", "nil", "missing"]) {
  console.log("read", key, render(current[key]), current[key] === undefined, current[key] === null);
}
const additions: BindingMap = { keep: "new", added: null };
const updated: Config = {
  ...config,
  bindings: entries.map(value => value === entry ? { ...value, bindings: { ...current, ...additions } } : value),
};
console.log("keys", Object.keys(updated).join(","));
console.log("updated", JSON.stringify(updated));
console.log("source", JSON.stringify(config));
console.log("identity", config !== updated, config.metadata === updated.metadata, config.bindings !== updated.bindings);
updated.metadata!.count = 3;
console.log("shared metadata", config.metadata!.count);
const changed = updated.bindings![0]!;
console.log("nested identity", entry !== changed, current !== changed.bindings, current.keep, changed.bindings!.keep);
changed.bindings!.nil = "changed";
console.log("independent map", render(current.nil), render(changed.bindings!.nil));
const shallow: Config = { ...config };
console.log("shared array", shallow.bindings === config.bindings, shallow.bindings![0] === entry);
shallow.bindings!.push({ context: "Other", bindings: { value: null } });
console.log("shared mutation", config.bindings!.length, entries.length);
entry.context = "Changed";
console.log("shared element", shallow.bindings![0]!.context, config.bindings![0]!.context);

let order = "";
function source(): Config { order += "S"; return config; }
function replacement(): Entry[] { order += "V"; return []; }
function effect(mark: string): string { order += mark; return mark; }
const ordered: Config = { before: effect("B"), ...source(), bindings: replacement(), after: effect("A") };
console.log("evaluation", order, Object.keys(ordered).join(","), ordered.bindings!.length);
function nullable(flag: boolean): BindingMap | null | undefined { return flag ? current : null; }
console.log("nullable spread", JSON.stringify({ ...nullable(false), ...nullable(true), final: null }));
const maybeValues: Record<string, string | null | undefined> = { nil: null, present: undefined, text: "text" };
const copied = { ...maybeValues };
for (const key of ["nil", "present", "text", "missing"]) {
  console.log("presence", key, render(copied[key]));
}
console.log("undefined keys", Object.keys(copied).join(","), JSON.stringify(copied));
function throwing(): Config { order += "T"; throw new Error("spread stopped"); }
order = "";
try { const stopped: Config = { ...throwing(), bindings: replacement() }; console.log(JSON.stringify(stopped)); }
catch (error) { console.log("throw order", order, (error as Error).message); }
const first: Config = { ...config, [effect("key")]: effect("value"), ...config };
console.log("computed order", order, Object.keys(first).join(","), JSON.stringify(first));
function append(config: Config): Config {
  const bindings = config.bindings;
  if (!Array.isArray(bindings)) return { ...config, bindings: [{ context: "Chat" }] };
  const found = bindings.find(value => typeof value === "object" && value !== null && value.context === "Chat");
  if (!found) return { ...config, bindings: [...bindings, { context: "Chat" }] };
  return config;
}
const empty: Config = { bindings: [], extra: "kept" };
const appended = append(empty);
console.log("guarded spread", JSON.stringify(append({ extra: "missing" })), JSON.stringify(appended));
console.log("array copy", appended.bindings !== empty.bindings, empty.bindings!.length, appended.bindings!.length);
console.log("no append", append(appended) === appended);
const raw: Entry = { context: "Other", bindings: { nil: null } };
const fromTyped = append({ bindings: [raw] });
console.log("typed element", fromTyped.bindings![0] === raw, fromTyped.bindings!.length);
raw.context = "Updated";
console.log("typed mutation", fromTyped.bindings![0]!.context);
function staleGuard(rows?: Entry[]): void {
  function clear(): void { rows = undefined; }
  if (Array.isArray(rows)) {
    clear();
    try { const copied = [...rows]; console.log("unreachable spread", copied.length); }
    catch (error) { console.log("stale guard", error instanceof TypeError); }
  }
}
const staleRows: Entry[] = [{ context: "Chat" }];
staleGuard(staleRows);
export {};
