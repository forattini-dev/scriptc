/// <reference types="node" />

import { realpathSync } from "node:fs";

const first = realpathSync(".");
const second = realpathSync(".");
console.log(first.length > 0);
console.log(first === second);
