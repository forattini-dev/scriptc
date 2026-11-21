// @rust-only
// @no-engine
import { existsSync } from "node:fs";

const alias = existsSync;
const paths = [import.meta.filename, `${import.meta.filename}.missing`];
console.log("filter", paths.filter(existsSync).length);
console.log("alias", alias(import.meta.filename), alias === existsSync);
