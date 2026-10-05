import { versions as runtime } from "node:process";

console.log(runtime.node);
console.log(runtime.node === process.versions.node);
function shadow(runtime: { node: string }): string { return runtime.node; }
console.log(shadow({ node: "local" }));
