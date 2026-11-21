/// <reference types="node" />
import { existsSync, mkdirSync, rmSync } from "node:fs";

function left(): string {
  return `.scriptc-mkdir-${process.pid}`;
}

function right(): string {
  return `.scriptc-mkdir-other-${process.pid}`;
}

const dir = process.platform === "win32" ? left() : right();
mkdirSync(dir, { recursive: true });
console.log(existsSync(dir));
rmSync(dir, { recursive: true, force: true });
