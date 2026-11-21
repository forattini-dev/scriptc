/// <reference types="node" />
import { basename } from "node:path/posix";
import { existsSync } from "node:fs";
import { platform } from "node:os";
console.log("native module initialized");
console.log(existsSync("."));
console.log(platform());
export function value(): string { return basename("/example/file.txt"); }
