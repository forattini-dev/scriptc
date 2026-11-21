// @rust-only
// @no-engine
const ns = await import("./module.ts");
const { use, echo, services, signature } = ns;
const read = async (key: string): Promise<string> => `value:${key}`;
const seams = { read };
console.log(await use(), await use(seams));
const p = Promise.resolve("preserved");
const q = echo(p);
console.log("promise identity", q === p, await q);
const alias = services;
console.log("services", services === ns.services, await services[0]!.run());
console.log("callback identity", services[0]!.run === services[0]!.run);
alias[0]!.name = "mutated";
console.log(ns.services[0]!.name, await services[0]!.optional!());
console.log("pattern", signature(/a/g).test("a"));
const original = Promise.resolve(" checked ");
const source: unknown = original;
const checked = source as Promise<string>;
console.log("cast identity", checked === original, (await checked).trim());
const invalid: unknown = Promise.resolve(9);
try {
  const value = await (invalid as Promise<string>);
  if (typeof value !== "string") throw new TypeError("invalid payload");
}
catch (error) { console.log("payload", (error as Error).name); }
const rejected: Promise<string> = Promise.reject(new Error("rejected"));
try { await echo(rejected); }
catch (error) { console.log("rejected", (error as Error).message); }
export {};
