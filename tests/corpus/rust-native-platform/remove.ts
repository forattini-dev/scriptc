import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const root = "remove-fixture";
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/value`, "data");
rmSync(root, { recursive: true, force: true });
console.log(existsSync(root));
rmSync(root, { force: true });
