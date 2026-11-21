// @rust-only
// @no-engine
const files = new Map<string, { hunks: number; added: number }>();
files.set("a", { hunks: 0, added: 1 });
files.get("a")!.hunks++;
++files.get("a")!.added;
console.log(files.get("a")!.hunks, files.get("a")!.added);
