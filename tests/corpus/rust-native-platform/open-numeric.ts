import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const path = "numeric-open-fixture.txt";
appendFileSync(path, "preserved");
const descriptor = openSync(path, 0, 0o600);
const snapshot = fstatSync(descriptor);
console.log(snapshot.isFile(), snapshot.isDirectory(), snapshot.size);
const pathSnapshot = statSync(path);
console.log("same-file", snapshot.ino === pathSnapshot.ino, snapshot.dev === pathSnapshot.dev);
console.log(snapshot.mtimeMs > 0, Date.now() + 2000 >= snapshot.mtimeMs);
closeSync(descriptor);
try {
  fstatSync(descriptor);
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code === "EBADF");
}
console.log(readFileSync(path, "utf8"));
try {
  openSync(path, 0.5);
} catch (error) {
  console.log((error as Error).name);
}
unlinkSync(path);
const lock = openSync(path, "wx", 0o600);
writeFileSync(lock, `${process.pid > 0}\n`);
closeSync(lock);
console.log(readFileSync(path, "utf8"));
try {
  openSync(path, "wx", 0o600);
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code === "EEXIST");
}
unlinkSync(path);

const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const created = openSync(path, flags, 0o600);
fchmodSync(created, 0o600);
appendFileSync(created, "ação");
closeSync(created);
console.log(readFileSync(path, "utf8"));
try {
  fchmodSync(created, 0o600);
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code === "EBADF");
}
try {
  openSync(path, flags, 0o600);
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code === "EEXIST");
}
unlinkSync(path);
