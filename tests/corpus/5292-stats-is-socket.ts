/// <reference types="node" />
import { statSync } from "node:fs";

const current = statSync(".");
console.log(current.isDirectory(), current.isSocket());
