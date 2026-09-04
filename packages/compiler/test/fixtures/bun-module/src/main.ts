/// <reference path="./bun.d.ts" />
import { pathToFileURL, fileURLToPath } from "bun";
import { readFileSync } from "node:fs";
const url = pathToFileURL("/a b/c.txt");
console.log(url.protocol === "file:", url.href.endsWith("/c.txt"));
console.log(fileURLToPath("file:///tmp/x%20y") === "/tmp/x y");
const round = fileURLToPath(pathToFileURL("/tmp/z").href);
console.log(round === "/tmp/z");
