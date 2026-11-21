import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const path = "write-file-fixture.txt";
writeFileSync(path, "first", { encoding: "utf8", mode: 0o600 });
console.log(existsSync(path), readFileSync(path, "utf8"));
writeFileSync(path, "second", { flag: "w", flush: false });
console.log(readFileSync(path, "utf8"));
unlinkSync(path);
