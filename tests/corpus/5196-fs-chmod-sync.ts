/// <reference types="node" />
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";

const path = `.scriptc-chmod-${process.pid}.txt`;
writeFileSync(path, "native", "utf8");
chmodSync(path, 0o600);
console.log((statSync(path).mode & 0o200) !== 0);
rmSync(path, { force: true });
