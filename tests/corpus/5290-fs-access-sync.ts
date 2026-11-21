/// <reference types="node" />
import { accessSync, constants, rmSync, writeFileSync } from "node:fs";

writeFileSync("present.txt", "ok");
accessSync("present.txt");
accessSync("present.txt", constants.F_OK);
let missing = false;
try {
  accessSync("missing.txt", constants.F_OK);
} catch (error) {
  missing = (error as NodeJS.ErrnoException).code === "ENOENT";
}
console.log(missing);
rmSync("present.txt", { force: true });
