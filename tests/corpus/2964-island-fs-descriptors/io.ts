// The island module (Proxy keeps it there): file work through
// descriptors the way Effect's FileSystem drives it — open, positioned
// read/write, fstat, truncate, close — in the sync, callback, and
// FileHandle spellings.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const guard = new Proxy({ on: true }, {});

export function syncRoundTrip(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-fd-"));
  const file = path.join(dir, "notes.txt");
  const fd = fs.openSync(file, "w+");
  const written = fs.writeSync(fd, "hello descriptor world");
  fs.writeSync(fd, Buffer.from("HELLO"), 0, 5, 0);
  const size = fs.fstatSync(fd).size;
  const buffer = Buffer.alloc(10);
  const read = fs.readSync(fd, buffer, 0, 10, 6);
  const tail = Buffer.alloc(5);
  const tailRead = fs.readSync(fd, tail, { position: size - 5 });
  fs.ftruncateSync(fd, 5);
  const truncated = fs.fstatSync(fd).size;
  fs.closeSync(fd);
  const whole = fs.readFileSync(file, "utf8");
  fs.rmSync(dir, { recursive: true });
  return `${written} ${size} ${read}:${buffer.toString("utf8")} ${tailRead}:${tail.toString("utf8")} ${truncated} ${whole}${(guard as { on: boolean }).on ? "" : "?"}`;
}

export function callbackRead(): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-fd-"));
    const file = path.join(dir, "cb.txt");
    fs.writeFileSync(file, "0123456789");
    fs.open(file, "r", (err, fd) => {
      if (err) return reject(err);
      const buffer = Buffer.alloc(4);
      fs.read(fd, { buffer, position: 3 }, (err2, bytesRead, buf) => {
        if (err2) return reject(err2);
        fs.fstat(fd, (err3, stats) => {
          if (err3) return reject(err3);
          fs.close(fd, (err4) => {
            if (err4) return reject(err4);
            fs.rmSync(dir, { recursive: true });
            resolve(`${bytesRead}:${buf.toString("utf8")} size=${stats.size} file=${stats.isFile()}`);
          });
        });
      });
    });
  });
}

export async function handleRoundTrip(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-fd-"));
  const file = path.join(dir, "handle.bin");
  const handle = await fs.promises.open(file, "w+");
  const { bytesWritten } = await handle.write(Buffer.from("abcdefgh"));
  const buffer = Buffer.alloc(3);
  const { bytesRead } = await handle.read(buffer, 0, 3, 2);
  const stats = await handle.stat();
  const text = await handle.readFile("utf8");
  await handle.close();
  let closedError = "";
  try {
    await handle.stat();
  } catch (e) {
    closedError = (e as { code: string }).code;
  }
  fs.rmSync(dir, { recursive: true });
  return `${bytesWritten} ${bytesRead}:${buffer.toString("utf8")} ${stats.size} ${JSON.stringify(text)} ${closedError}`;
}

export function missing(): string {
  try {
    fs.openSync(path.join(os.tmpdir(), "scriptc-fd-missing", "nope.txt"), "r");
    return "opened?";
  } catch (e) {
    const err = e as { code: string; syscall: string };
    return `${err.code} ${err.syscall}`;
  }
}
