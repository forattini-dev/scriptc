/// <reference types="node" />
import path, { delimiter } from "node:path";

function splitPath(value: string): string {
  return value.split(delimiter).join("|");
}

console.log(delimiter === path.delimiter, splitPath(`first${delimiter}second`));
