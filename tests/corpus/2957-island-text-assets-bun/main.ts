// @dynamic
// @target bun
// @island-module: ./prompts.ts
// Text assets imported by an ISLAND module embed as string modules (the
// static tier bakes them as constants); the engine never sees raw text
// as JavaScript.
import { prompt, notes } from "./prompts.ts";

console.log(prompt().split("\n")[0]);
console.log(prompt().length, notes().startsWith("# Notes"), notes().length);
