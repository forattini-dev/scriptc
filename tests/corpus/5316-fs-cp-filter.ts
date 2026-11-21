/// <reference types="node" />
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = `.scriptc-cp-filter-${process.pid}`;
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/from/nested`, { recursive: true });
writeFileSync(`${root}/from/keep.txt`, "keep");
writeFileSync(`${root}/from/skip.txt`, "skip");
writeFileSync(`${root}/from/nested/value.txt`, "nested");
cpSync(`${root}/from`, `${root}/to`, {
  recursive: true,
  dereference: true,
  filter: (source) => !source.endsWith("skip.txt"),
});
console.log(
  existsSync(`${root}/to/keep.txt`),
  existsSync(`${root}/to/skip.txt`),
  existsSync(`${root}/to/nested/value.txt`),
);
rmSync(root, { recursive: true, force: true });
