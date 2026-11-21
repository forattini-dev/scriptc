/// <reference types="node" />
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const source = `.scriptc-copy-file-${process.pid}.source`;
const destination = `.scriptc-copy-file-${process.pid}.destination`;
writeFileSync(source, "native:rust", "utf8");
copyFileSync(source, destination);
console.log(readFileSync(destination, "utf8"));
rmSync(source, { force: true });
rmSync(destination, { force: true });
