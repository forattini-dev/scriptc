// Numeric O_* opens retain POSIX no-follow/exclusive semantics;
// descriptor stat/chmod/sync and link publication keep the same fd identity.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-fd-publish-"));
const source = path.join(dir, "pending.txt");
const published = path.join(dir, "published.txt");
const symlink = path.join(dir, "alias.txt");
try {
  if (process.platform !== "win32") {
    const fd = fs.openSync(source, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    console.log("created", fs.fstatSync(fd).isFile());
    fs.fchmodSync(fd, 0o600);
    const data = Buffer.from("atomic\n", "utf8");
    console.log("wrote", fs.writeSync(fd, data, 0, data.length));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.linkSync(source, published);
    const input = fs.openSync(published, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    console.log("read", fs.fstatSync(input).isFile(), fs.readFileSync(input, "utf8").trim());
    fs.closeSync(input);
    try {
      fs.linkSync(source, published);
    } catch (error) {
      if (error instanceof Error) console.log("exclusive", error.message.includes("EEXIST"));
    }
    execFileSync("ln", ["-s", source, symlink]);
    try {
      const unsafe = fs.openSync(symlink, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      fs.closeSync(unsafe);
      console.log("followed");
    } catch (error) {
      if (error instanceof Error) console.log("no-follow", error.message.includes("ELOOP"));
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
