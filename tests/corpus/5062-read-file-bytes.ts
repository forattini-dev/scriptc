// @ts-nocheck
import { readFileSync } from "node:fs";

const data = readFileSync("package.json");
console.log(data.length > 0);
