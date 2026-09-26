import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pc = require("picocolors") as typeof import("picocolors");

console.log(pc.green("create-require"));
console.log(pc.bold(pc.blue("static")));
