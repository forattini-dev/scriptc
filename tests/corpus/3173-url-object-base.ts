// @rust-only
/// <reference types="node" />
import { URL as NodeURL } from "node:url";

// The Redcode skill discovery pattern: chain URL objects as bases.
const source = new URL("https://example.test/skills/");
console.log(new URL("index.json", source).href);
const skill = new URL("one/", source);
console.log(new URL("SKILL.md", skill).href);
console.log(new NodeURL("../two/", skill).href);

function input(): string {
  console.log("input");
  source.pathname = "/changed/";
  return "index.json";
}
function base(): URL {
  console.log("base");
  return source;
}
console.log(new URL(input(), base()).href);
source.searchParams.set("key", "value");
console.log(new URL("#fragment", source).href);
console.log(new URL("../x", new URL("file:////server/a/b")).href);
console.log(source.href);
