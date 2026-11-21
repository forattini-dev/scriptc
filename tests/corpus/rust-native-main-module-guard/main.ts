import { fileURLToPath, pathToFileURL } from "node:url";
import { helperIsMain } from "./helper.ts";

const invokedDirectly = process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

console.log("main guard", invokedDirectly);
console.log("pathToFileURL guard", import.meta.url === pathToFileURL(process.argv[1]!).href);
console.log("fileURLToPath guard", fileURLToPath(import.meta.url) === process.argv[1]);
console.log("imported module is main", helperIsMain());
console.log("args", process.argv.slice(2).length);
