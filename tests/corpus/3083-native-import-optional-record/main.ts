// @rust-only
// @no-engine
import type { Options } from "./module.ts";
const names = ["n"];
const options: Options = {
  aliases: names,
  fail: false,
};
const module = await import("./module.ts");
await module.run(options);
console.log("after", options.aliases === undefined, names.join(","));
options.aliases = ["replacement"];
await module.run(options);
console.log("replaced", options.aliases === undefined, names.join(","));
options.fail = true;
try { await module.run(options); } catch (error) {
  if (error instanceof Error) console.log("throw", error.message);
}
