/// <reference types="node" />
import { existsSync, mkdirSync, rmdirSync } from "node:fs";

mkdirSync("empty");
console.log(existsSync("empty"));
rmdirSync("empty");
console.log(existsSync("empty"));
