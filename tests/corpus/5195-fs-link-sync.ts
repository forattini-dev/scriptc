/// <reference types="node" />
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const source = `.scriptc-link-${process.pid}.source`;
const linked = `.scriptc-link-${process.pid}.linked`;
writeFileSync(source, "native:rust", "utf8");
linkSync(source, linked);
writeFileSync(source, "shared", "utf8");
console.log(readFileSync(linked, "utf8"));
rmSync(linked, { force: true });
rmSync(source, { force: true });
