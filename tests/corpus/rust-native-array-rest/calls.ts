function combine(prefix: string = "default", ...parts: string[]): string { return prefix + ":" + parts.join("|"); }
const alias: (prefix?: string, ...parts: string[]) => string = combine;
const holder = { run: alias };
function invoke(callback: typeof combine): string { return callback(undefined, "a", "b"); }
function returned(): typeof combine { return alias; }
console.log("calls", combine(), combine(undefined, "a"), combine("p", "a", "b"));
console.log("aliases", invoke(alias), holder.run("record", "x", "y"), returned()("returned", "z"));
const captured = (suffix: string) => (...parts: string[]) => parts.join("-") + suffix;
console.log(captured("!")("a", "b"));
function recurse(n: number, ...parts: string[]): string {
  if (n === 0) return parts.join("|");
  return recurse(n - 1, "next", parts.join("-"));
}
console.log(recurse(2, "a", "b"));
