// @rust-only
// @no-engine
export {};
const kinds = ["dark", "light", "obsidian"] as const;
const alias = kinds;
function has(value: string): boolean {
  return (alias as readonly string[]).includes(value);
}
console.log("members", has("dark"), has("obsidian"), has("missing"));
console.log("from", (kinds as readonly string[]).includes("dark", 1), (kinds as readonly string[]).includes("obsidian", -1));
let effects = "";
function receiver(): readonly ["dark", "light", "obsidian"] { effects += "r"; return kinds; }
function search(): string { effects += "s"; return "light"; }
function offset(): number { effects += "i"; return 1; }
console.log("order", (receiver() as readonly string[]).includes(search(), offset()), effects);
console.log("identity", alias === kinds);
const mutable: [string, string] = ["a", "b"];
function update(): string { mutable[1] = "changed"; return "changed"; }
console.log("live", (mutable as readonly string[]).includes(update()), mutable[1]);
