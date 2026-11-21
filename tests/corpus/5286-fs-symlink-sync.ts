/// <reference types="node" />
import { mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";

mkdirSync("target");
try {
  symlinkSync("target", "alias", "dir");
  console.log(`linked:${readlinkSync("alias")}`);
  rmSync("alias", { force: true });
} catch (error) {
  console.log(`error:${(error as NodeJS.ErrnoException).code}`);
} finally {
  rmSync("target", { recursive: true, force: true });
}
