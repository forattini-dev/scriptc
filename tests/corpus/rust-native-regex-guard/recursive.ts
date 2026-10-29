// @rust-only
// @no-engine
export {};
function resolve(path: string, visited: ReadonlySet<string>): string {
  if (visited.has(path)) return "cycle";
  if (path === "end") return path;
  const alias = /^\{([^{}]+)\}$/.exec(path);
  if (alias?.[1] === undefined) throw new Error("invalid");
  return resolve(alias[1], new Set([...visited, path]));
}
console.log("resolved", resolve("{end}", new Set<string>()));
try { resolve("missing", new Set<string>()); }
catch (error) { console.log("invalid", (error as Error).message); }
