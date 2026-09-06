// @dynamic
// @target bun
// @island-module: ./config.ts
// Under the bun target a CommonJS module's ESM facade exposes every key
// Bun's evaluation would (a permissive syntactic superset), so named
// imports link where Node's lexer-built facade would refuse the graph.
import { describe, accessors } from "./config.ts";

console.log(describe());
console.log(accessors());
