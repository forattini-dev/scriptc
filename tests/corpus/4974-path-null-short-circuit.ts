/// <reference types="node" />
import { join } from "node:path";

function candidate(value: string): string | null {
  return value.length === 0 ? null : value;
}

const dir = candidate("root");
if (dir === null || join(dir, "manifest.json").length === 0) {
  console.log("missing");
} else {
  console.log(join(dir, "manifest.json"));
}
