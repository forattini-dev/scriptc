// @rust-only
// @target bun
// @no-engine
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "scriptc-bun-write-"));
const path = join(root, "ação.txt");
async function contents(): Promise<void> {
  const count = await Bun.write(path, "ação🚀");
  console.log("utf8", count, readFileSync(path, "utf8") === "ação🚀");
  const sharedRead = await Bun.file(path).text(); console.log("shared IO pool", sharedRead === "ação🚀");
  const bom = await globalThis.Bun.write(path, "\uFEFFa");
  console.log("bom", bom, readFileSync(path).toString("hex"));
  writeFileSync(path, "original long contents");
  const short = await Bun.write(path, "new");
  console.log("truncate", short, readFileSync(path, "utf8"));
  const empty = await Bun.write(path, "");
  console.log("empty", empty, statSync(path).size);
  const parent = join(root, "nested", "more", "text");
  const nested = await Bun.write(parent, "created");
  console.log("parents", nested, readFileSync(parent, "utf8"));
  const emptyNested = await Bun.write(join(root, "empty", "nested", "text"), "");
  console.log("empty parents", emptyNested);
}
async function buffers(): Promise<void> {
  const bytes = new Uint8Array([0, 255, 97]);
  const write = Bun.write(path, bytes); bytes[0] = 99;
  const count = await write;
  console.log("snapshot", count, readFileSync(path).toString("hex"));
  const sliced = new Uint8Array([9, 65, 66, 9]).subarray(1, 3);
  const sliceCount = await Bun.write(path, sliced);
  console.log("view", sliceCount, readFileSync(path, "utf8"));
  const bufferCount = await Bun.write(path, Buffer.from([239, 187, 191, 97]));
  console.log("buffer", bufferCount, readFileSync(path).toString("hex"));
  const large = new Uint8Array(262144); large[0] = 65;
  const pending = Bun.write(path, large); large[0] = 66;
  const largeCount = await pending;
  console.log("large snapshot", largeCount, readFileSync(path)[0]);
}
async function timing(text: string, name: string): Promise<void> {
  let order = "";
  const write = Bun.write(path, text).then(() => { order += "write,"; });
  Promise.resolve().then(() => { order += "micro,"; });
  await write;
  console.log(name, order);
}
async function ordering(): Promise<void> {
  let calls = "";
  function destination(): string { calls += "path,"; return path; }
  function data(): string { calls += "data,"; return "x"; }
  await Bun.write(destination(), data()); console.log("once", calls);
  await timing("", "empty order");
  await timing("x", "small order");
  await timing("é".repeat(262143), "UTF16 below boundary");
  await timing("x".repeat(262144), "boundary");
  let order = "";
  const pending = Bun.write(join(root, "pending-parent", "text"), "x").then(() => { order += "write,"; });
  Promise.resolve().then(() => { order += "micro,"; });
  await pending; console.log("parent order", order);
}
async function failures(): Promise<void> {
  let phase = "call";
  try { const pending = Bun.write(root, "x"); phase = "await"; await pending; } catch (error) {
    console.log("directory", phase, (error as Error).name, (error as NodeJS.ErrnoException).code);
    console.log("directory message", (error as Error).message === "EISDIR: illegal operation on a directory, open '" + root + "'");
  }
  try { await Bun.write("", ""); } catch (error) { console.log("empty path", (error as Error).message); }
  phase = "call";
  try { const pending = Bun.write("a\0b", "x"); phase = "await"; await pending; } catch (error) {
    console.log("nul", phase, error instanceof TypeError, (error as NodeJS.ErrnoException).code, (error as Error).message);
  }
  let order = "";
  function badPath(): string { order += "path,"; return "a\0b"; }
  function badData(): string { order += "data,"; throw new Error("data failed"); }
  try { await Bun.write(badPath(), badData()); } catch (error) { console.log("argument throw", order, (error as Error).message); }
}
async function relativeAndShadow(): Promise<void> {
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const count = await Bun.write("relative.txt", "relative");
    console.log("relative", count, readFileSync("relative.txt", "utf8"));
  } finally { process.chdir(cwd); }
  const custom = { write: async (path: string, text: string): Promise<number> => path.length + text.length };
  function shadow(Bun: typeof custom): Promise<number> { return Bun.write("abc", "defg"); }
  const count = await shadow(custom); console.log("shadow", count);
}
async function ioFailure(destination: string, data: string, name: string): Promise<void> {
  try { await Bun.write(destination, data); } catch (error) {
    console.log(name, (error as Error).name, (error as NodeJS.ErrnoException).code, (error as Error).message.replace(root, "<root>"));
  }
}
try {
  await contents(); await buffers(); await ordering(); await failures(); await relativeAndShadow();
  await ioFailure(root, "", "empty directory");
  await ioFailure(join(path, "child"), "", "empty parent file");
  await ioFailure(join(path, "child"), "x", "small parent file");
  await ioFailure(join(path, "child"), "x".repeat(262144), "large parent file");
  await ioFailure("", "x", "nonempty empty path");
} finally { rmSync(root, { recursive: true, force: true }); }
