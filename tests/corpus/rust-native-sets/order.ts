// @rust-only
// @no-engine
const set = new Set<string>();
function receiver(): Set<string> { console.log("receiver"); return set; }
function argument(): string { console.log("argument", set.size); return "key"; }
console.log("add", receiver().add(argument()) === set, set.size);
console.log("has", receiver().has(argument()));
console.log("delete", receiver().delete(argument()), set.size);
receiver().clear();
console.log("clear", set.size);
function optional(value: Set<string> | undefined): number {
  if (value !== undefined) { value.add("guarded"); return value.size; }
  return -1;
}
console.log("optional", optional(set), optional(undefined));
