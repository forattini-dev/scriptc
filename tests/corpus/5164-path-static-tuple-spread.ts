/// <reference path="./rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
import { join } from "node:path";

const SEGMENTS = [".red", "skills"] as const;
console.log(join("home", ...SEGMENTS));
