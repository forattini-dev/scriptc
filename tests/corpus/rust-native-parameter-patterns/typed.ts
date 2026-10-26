type Options = { name: string; retries?: number; enabled?: boolean; note?: string | null };
function choose({ name: label, retries = 3, enabled = true, note = "default", ...rest }: Options): string {
  return label + ":" + String(retries) + ":" + String(enabled) + ":" + String(note) + ":" + Object.keys(rest).join("|");
}
console.log("typed", choose({name: "one"}), choose({name: "two", retries: 0, enabled: false, note: null}));
function outer({ name = "empty", retries = 2 }: { name?: string; retries?: number } = {}): string {
  return name + ":" + String(retries);
}
console.log("outer", outer(), outer(undefined), outer({}), outer({name: "", retries: 0}));
function previous(prefix: string, { name = prefix, other = name }: { name?: string; other?: string } = {}): string {
  return name + ":" + other;
}
console.log("earlier", previous("P"), previous("P", {name: "N"}));
