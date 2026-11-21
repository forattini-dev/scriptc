import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

interface FileOps {
  appendFile(path: string, data: string, encoding: "utf8"): Promise<unknown>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { recursive?: boolean; force: true }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag?: "wx" },
  ): Promise<unknown>;
}

const fs: FileOps = { appendFile, mkdir, readFile, rename, rm, writeFile };

async function main(): Promise<void> {
  const root = "scriptc-fs-function-values";
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(`${root}/first.txt`, "ready", { encoding: "utf8", flag: "wx" });
  await fs.appendFile(`${root}/first.txt`, "!", "utf8");
  console.log(await fs.readFile(`${root}/first.txt`, "utf8"));
  await fs.rename(`${root}/first.txt`, `${root}/second.txt`);
  await fs.rm(root, { recursive: true, force: true });
  console.log("done");
}

void main();
