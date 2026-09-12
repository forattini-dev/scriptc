// Static ESM metadata is module-local and does not depend on the process cwd.
import { fileURLToPath } from "node:url";
import { basename, dirname as pathDirname } from "node:path";
import { imported } from "./module with space.mjs";

process.chdir("/tmp");

const here = {
  main: import.meta.main,
  filename: import.meta.filename,
  dirname: import.meta.dirname,
  url: import.meta.url,
};

console.log("entry", here.main, basename(here.filename), basename(here.dirname));
console.log("entry-url", here.url.startsWith("file://"), here.url.includes("main.mjs"));
console.log("entry-bridge", fileURLToPath(here.url) === here.filename, pathDirname(here.filename) === here.dirname);
console.log("entry-encoding", here.url.includes("%20"), here.filename.includes("%20") === false);
console.log("imported", imported.main, basename(imported.filename), imported.url.includes("module%20with%20space.mjs"));
console.log("imported-bridge", fileURLToPath(imported.url) === imported.filename, pathDirname(imported.filename) === imported.dirname);
