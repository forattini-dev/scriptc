type Provider =
  | { kind: "gh"; repo: string; asset: string; bin?: string }
  | { kind: "mise"; spec: string; alias?: string; version?: string; allow?: boolean };
const gh = (repo: string, asset: string, bin?: string): Provider => ({
  kind: "gh", repo, asset, ...(bin ? { bin } : {}),
});
const mise = (spec: string, opts: { alias?: string; version?: string; allow?: boolean } = {}): Provider => ({
  kind: "mise", spec,
  ...(opts.alias ? { alias: opts.alias } : {}),
  ...(opts.version ? { version: opts.version } : {}),
  ...(opts.allow ? { allow: true } : {}),
});
console.log("provider", gh("r", "a").kind, Object.hasOwn(gh("r", "a"), "bin"));
console.log(Object.hasOwn(gh("r", "a", ""), "bin"), Object.hasOwn(gh("r", "a", "tool"), "bin"));
const p = mise("package", { version: "1.2", allow: true });
const keys = Object.keys(p);
console.log("keys", p.kind, keys.length, keys[0], keys[1], keys[2], keys[3]);
console.log(Object.hasOwn(p, "alias"), Object.hasOwn(p, "allow"));
console.log(Object.keys(mise("empty")).length);
