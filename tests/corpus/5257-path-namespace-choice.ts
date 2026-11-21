/// <reference types="node" />
import { posix, win32 } from "node:path";

function describe(windows: boolean): string {
  const path = windows ? win32 : posix;
  return `${path.join("alpha", "beta")}|${path.isAbsolute(windows ? "C:\\x" : "/x")}`;
}

console.log(describe(false));
console.log(describe(true));

for (const windows of [false, true]) {
  const path = windows ? win32 : posix;
  const file = windows ? "C:\\alpha\\..\\beta\\file.txt" : "/alpha/../beta/file.txt";
  const root = windows ? "C:\\alpha" : "/alpha";
  const target = windows ? "C:\\alpha\\beta" : "/alpha/beta";
  console.log(path.normalize(file));
  console.log(path.dirname(file));
  console.log(path.basename(file, ".txt"));
  console.log(path.extname(file));
  console.log(path.relative(root, target));
  console.log(path.resolve(root, "beta"));
  console.log(path.sep);
  console.log(path.delimiter);
}
