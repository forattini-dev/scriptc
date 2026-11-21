/// <reference types="node" />
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = ".scriptc-cp-sync-test";
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/from/nested`, { recursive: true });
writeFileSync(`${root}/from/nested/value.txt`, "native");
cpSync(`${root}/from`, `${root}/to`, { recursive: true });
console.log(existsSync(`${root}/to/nested/value.txt`));
rmSync(root, { recursive: true, force: true });
