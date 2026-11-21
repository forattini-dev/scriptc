/// <reference path="./rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
import * as nodeFs from "node:fs";

function present(
  path: string,
  fs: Pick<typeof nodeFs, "existsSync"> = nodeFs,
): boolean {
  return fs.existsSync(path);
}

function directory(
  path: string,
  fs: Pick<typeof nodeFs, "lstatSync"> = nodeFs,
): boolean {
  const stat = fs.lstatSync(path);
  return stat.isDirectory();
}

function guardedDirectory(
  path: string,
  fs: Pick<typeof nodeFs, "lstatSync"> = nodeFs,
): boolean {
  let stat: nodeFs.Stats;
  try {
    stat = fs.lstatSync(path);
  } catch {
    return false;
  }
  return stat.isDirectory();
}

console.log(
  present(process.cwd()),
  present(process.cwd(), { existsSync: () => false }),
  directory(process.cwd()),
  guardedDirectory(process.cwd()),
);
