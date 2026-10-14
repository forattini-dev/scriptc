// The wider sync fs slice: unlinkSync, chmodSync, chownSync,
// copyFileSync, writeFileSync's { mode } options form, mkdirSync's mode
// option, and the "utf-8" encoding alias — Node-differential, with the
// errno `.code` stamps checked where Node stamps them (paths carry a
// random mkdtemp component, so error MESSAGES assert through includes).
import {
  accessSync, chmodSync, chownSync, constants, copyFileSync, existsSync,
  mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-fsw-"));

// writeFileSync with { mode }: applies at creation (umask allowing).
writeFileSync(join(dir, "a.txt"), "alpha", { mode: 0o600 });
console.log("read utf-8:", readFileSync(join(dir, "a.txt"), "utf-8"));
// The encoding-only options form is the plain write.
writeFileSync(join(dir, "e.txt"), "enc", { encoding: "utf8" });
console.log("enc:", readFileSync(join(dir, "e.txt"), "utf8"));

// A read-only creation mode: the write bit is really absent.
writeFileSync(join(dir, "ro.txt"), "locked", { mode: 0o400 });
try {
  accessSync(join(dir, "ro.txt"), constants.W_OK);
} catch (e) {
  if (e instanceof Error) {
    console.log("ro:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("access"));
  }
}
// POSIX creation modes leave existing files unchanged. Windows CREATE_ALWAYS
// applies the readonly creation attribute even to an existing writable file.
writeFileSync(join(dir, "a.txt"), "beta", { mode: 0o400 });
if (process.platform === "win32") {
  try { accessSync(join(dir, "a.txt"), constants.W_OK); console.log("existing mode unexpectedly writable"); }
  catch (error) { if (error instanceof Error) console.log("existing readonly:", (error as NodeJS.ErrnoException).code); }
  chmodSync(join(dir, "a.txt"), 0o600);
} else { accessSync(join(dir, "a.txt"), constants.W_OK); }
console.log("existing keeps mode:", readFileSync(join(dir, "a.txt"), "utf-8"));

// chmodSync: flip the write bit off and back on.
chmodSync(join(dir, "a.txt"), 0o444);
try {
  accessSync(join(dir, "a.txt"), constants.W_OK);
} catch (e) {
  if (e instanceof Error) console.log("chmod off:", `${(e as NodeJS.ErrnoException).code}`);
}
chmodSync(join(dir, "a.txt"), 0o644);
accessSync(join(dir, "a.txt"), constants.W_OK);
console.log("chmod on: ok");
try {
  chmodSync(join(dir, "nope"), 0o644);
} catch (e) {
  if (e instanceof Error) {
    console.log("chmod missing:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("chmod"));
  }
}

// chownSync: -1/-1 is POSIX "leave unchanged" — succeeds without root.
chownSync(join(dir, "a.txt"), -1, -1);
console.log("chown noop: ok");
try {
  chownSync(join(dir, "nope"), -1, -1);
} catch (e) {
  if (e instanceof Error) {
    console.log("chown missing:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("chown"));
  }
}

// copyFileSync: contents copy; a missing source reports BOTH paths.
copyFileSync(join(dir, "a.txt"), join(dir, "b.txt"));
console.log("copied:", readFileSync(join(dir, "b.txt"), "utf-8"));
try {
  copyFileSync(join(dir, "nope"), join(dir, "c.txt"));
} catch (e) {
  if (e instanceof Error) {
    console.log(
      "copy missing:",
      `${(e as NodeJS.ErrnoException).code}`,
      e.message.includes("copyfile"),
      e.message.includes("nope' -> '"),
      e.message.endsWith("c.txt'"),
    );
  }
}

// mkdirSync with modes: the plain and recursive forms.
mkdirSync(join(dir, "plain"), { mode: 0o700 });
console.log("plain dir:", existsSync(join(dir, "plain")));
mkdirSync(join(dir, "deep/er/est"), { recursive: true, mode: 0o755 });
console.log("deep dir:", existsSync(join(dir, "deep/er/est")));

// unlinkSync: removes files, throws ENOENT after, EPERM-family on dirs.
unlinkSync(join(dir, "b.txt"));
console.log("unlinked:", !existsSync(join(dir, "b.txt")));
try {
  unlinkSync(join(dir, "b.txt"));
} catch (e) {
  if (e instanceof Error) {
    console.log("unlink missing:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("unlink"));
  }
}

rmSync(dir, { recursive: true, force: true });
console.log("done:", !existsSync(dir));
