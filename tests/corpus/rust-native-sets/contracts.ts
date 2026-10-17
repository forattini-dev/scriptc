// @rust-only
// @no-engine
const paths = new Set<string>();
console.log("empty", paths.size, paths.has("/one"));
const alias = paths;
console.log("chain", paths.add("/one") === paths, paths.add("/one").add("/two") === alias);
console.log("paths", paths.size, alias.has("/one"), alias.has("/two"));
console.log("delete", paths.delete("missing"), paths.delete("/one"), alias.size);
function readonlySize(set: ReadonlySet<string>): number { return set.size; }
console.log("readonly", readonlySize(paths));
function capture(set: Set<string>): () => boolean { return () => set.has("/two"); }
console.log("capture", capture(paths)());
const holder = { paths };
const stored: Set<string>[] = [paths];
console.log("storage", holder.paths === paths, stored[0].has("/two"));
paths.clear();
console.log("cleared", alias.size, paths.has("/two"));
