// @rust-only
// @no-engine
import { readFileSync } from "node:fs";
import payload from "./payload.embedded" with { type: "file" };

console.log(readFileSync(payload, "utf8").trim());
