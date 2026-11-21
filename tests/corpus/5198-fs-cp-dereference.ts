/// <reference types="node" />
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = `.scriptc-cp-dereference-${process.pid}`;
const spec = { dir: "from" };
mkdirSync(`${root}/from`, { recursive: true });
writeFileSync(`${root}/from/value.txt`, "native", "utf8");
cpSync(`${root}/from`, `${root}/to`, { recursive: !!spec.dir, dereference: false });
console.log(readFileSync(`${root}/to/value.txt`, "utf8"));
rmSync(root, { recursive: true, force: true });
