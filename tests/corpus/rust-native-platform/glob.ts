import { globSync } from "node:fs";
import { join, sep } from "node:path";

const root = join(process.cwd(), "tests", "corpus", "fixtures", "glob-native");
console.log(globSync("**/*.txt", {
  cwd: root,
  exclude: ["**/target/**", "**/node_modules/**"],
}).map((path) => path.replaceAll(sep, "/")).sort().join(","));
