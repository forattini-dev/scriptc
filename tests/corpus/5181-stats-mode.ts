/// <reference types="node" />

import { lstatSync } from "node:fs";

const stat = lstatSync(".");
console.log(stat.mode > 0);

function hasMode(value: typeof stat | null): boolean {
  return (value?.mode ?? 0) > 0;
}

console.log(hasMode(stat));
console.log(hasMode(null));
