// fs/promises.access — the scaffolder's "does this path exist?" idiom
// (tuiuiu.js's `tuiuiu init` is built on it): the settled-promise twin of
// accessSync, fulfilling when the probe passes and REJECTING with the
// errno error when it does not, so `try { await access(p) } catch` reads
// as a boolean. Both the bare-path (F_OK) and explicit-mode spellings,
// through the named import and the fs.promises namespace.
import { access, mkdir, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "scr-fsp-access-"));
  const file = join(dir, "present.txt");
  const missing = join(dir, "absent.txt");

  console.log("before:", await exists(file));
  await writeFile(file, "hello");
  console.log("after:", await exists(file));
  console.log("missing:", await exists(missing));

  // Explicit modes: readable and writable both hold for a file this
  // process just created; the namespace spelling routes the same call.
  await access(file, constants.R_OK);
  await fs.promises.access(file, constants.R_OK | constants.W_OK);
  console.log("modes ok");

  // The rejection carries Node's errno shape, which is what callers gate
  // on when they do not want a bare boolean.
  try {
    await access(missing, constants.F_OK);
    console.log("unreachable");
  } catch (e) {
    if (e instanceof Error) {
      console.log("rejects:", e.message.startsWith("ENOENT"));
      console.log("code:", (e as NodeJS.ErrnoException).code);
    }
  }

  // A directory answers F_OK too — `init` uses exactly this to refuse a
  // non-empty target.
  await mkdir(join(dir, "sub"));
  console.log("dir:", await exists(join(dir, "sub")));

  rmSync(dir, { recursive: true, force: true });
  console.log("cleaned:", await exists(dir));
}

main();
