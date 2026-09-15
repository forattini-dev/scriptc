/// <reference path="./bun.d.ts" />
// One "bun" import mixing a node:url re-export (lowered natively) with a Bun
// runtime API (trapped at its use site under --target bun).
import { plugin, pathToFileURL } from "bun";

console.log(pathToFileURL("/tmp/q").href.endsWith("/tmp/q"));
try {
  plugin({ name: "demo" });
  console.log("registered");
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
console.log("after");
