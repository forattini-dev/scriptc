import { join, resolve, basename, dirname, extname } from "node:path";
import * as path from "node:path";

export const pathUtils = {
  join,
  resolve,
  basename,
  dirname,
  extname,
};

console.log(pathUtils.join("templates", "partials", "header.hbs"));
console.log(pathUtils.join());
console.log(pathUtils.basename("/srv/site/index.html"), pathUtils.basename("/srv/site/index.html", ".html"));
console.log(pathUtils.dirname("/srv/site/index.html"), pathUtils.extname("theme.min.css"));
console.log(pathUtils.resolve("/srv", "site", "..", "assets") === resolve("/srv/assets"));
const joinValue = path.join;
console.log(joinValue("a", "b", "c"));
const pick = (useBase: boolean) => (useBase ? basename : extname);
console.log(pick(true)("/x/y.txt"), pick(false)("/x/y.txt"));
