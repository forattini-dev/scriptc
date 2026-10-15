// @rust-only
// @target bun
// @no-engine
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "scriptc-bun-text-"));
const path = join(root, "ação.txt");
async function decoding(): Promise<void> {
  writeFileSync(path, "ação🚀\n");
  const utf8 = await Bun.file(path).text(); console.log("utf8", utf8 === "ação🚀\n");
  const global = await globalThis.Bun.file(path).text(); console.log("globalThis", global === "ação🚀\n");
  const parentheses = await (Bun.file(path)).text(); console.log("parentheses", parentheses === "ação🚀\n");
  writeFileSync(path, ""); const empty = await Bun.file(path).text(); console.log("empty", empty.length);
  writeFileSync(path, Buffer.from([239, 187, 191, 97]));
  const bom = await Bun.file(path).text(); console.log("bom", bom === "a");
  writeFileSync(path, Buffer.from([239, 187, 191, 239, 187, 191, 97]));
  const doubleBom = await Bun.file(path).text(); console.log("one bom", doubleBom === "\uFEFFa");
  writeFileSync(path, Buffer.from([240, 40, 140, 40]));
  const replacement = await Bun.file(path).text(); console.log("replacement", replacement === "\uFFFD(\uFFFD(");
  writeFileSync(path, Buffer.from([97, 0, 98]));
  const zero = await Bun.file(path).text(); console.log("zero byte", zero === "a\0b");
}
async function ordering(): Promise<void> {
  let calls = 0;
  function input(): string { calls += 1; return path; }
  await Bun.file(input()).text();
  console.log("once", calls);
  let order = "";
  const read = Bun.file(path).text().then(() => { order += "read"; });
  Promise.resolve().then(() => { order += "micro,"; });
  console.log("pending", order === "");
  await read;
  console.log("order", order);
}
async function failures(): Promise<void> {
  let phase = "call";
  try {
    const missing = Bun.file(join(root, "missing")).text();
    phase = "await";
    await missing;
  } catch (error) {
    console.log("missing", phase, error instanceof Error, (error as NodeJS.ErrnoException).code);
    console.log("missing message", (error as Error).message.endsWith("open '" + join(root, "missing") + "'"));
  }
  try { await Bun.file(root).text(); } catch (error) {
    console.log("directory", (error as Error).message, (error as NodeJS.ErrnoException).code);
  }
  phase = "call";
  try {
    const bad = Bun.file("a\0b").text();
    phase = "await";
    await bad;
  } catch (error) {
    console.log("nul", phase, error instanceof TypeError, (error as NodeJS.ErrnoException).code);
    console.log("nul message", (error as Error).message);
  }
  try { await Bun.file("").text(); } catch (error) { console.log("empty path", (error as Error).message); }
}
async function relativePath(): Promise<void> {
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const relativeText = await Bun.file("ação.txt").text();
    console.log("relative path", relativeText === "a\0b");
  } finally { process.chdir(cwd); }
}
async function shadowing(): Promise<void> {
  const custom = { file: (name: string) => ({ text: async (): Promise<string> => "custom:" + name }) };
  function shadow(Bun: typeof custom): Promise<string> { return Bun.file("x").text(); }
  const shadowed = await shadow(custom); console.log("shadow", shadowed);
}
try {
  await decoding();
  await ordering();
  await failures();
  await relativePath();
  await shadowing();
} finally { rmSync(root, { recursive: true, force: true }); }
