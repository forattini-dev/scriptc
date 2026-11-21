/// <reference types="node" />
import { readFileSync } from "node:fs";

function required(
  values: Record<string, string | undefined>,
  name: string,
): string {
  const value = values[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

const text = readFileSync(required({ manifest: "Cargo.toml" }, "manifest"), "utf8");
console.log(text.includes('name = "scriptc-compiler"'));
