/// <reference types="node" />
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const path = `.scriptc-write-fd-${process.pid}.json`;
let fd: number;
try {
  fd = openSync(path, "wx", 0o600);
} catch {
  rmSync(path, { force: true });
  fd = openSync(path, "wx", 0o600);
}
try {
  writeFileSync(fd, JSON.stringify({ host: "native", values: [1, 2] }));
} finally {
  closeSync(fd);
}
console.log(readFileSync(path, "utf8"));
rmSync(path, { force: true });
