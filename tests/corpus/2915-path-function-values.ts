// Exact-arity node:path functions are first-class static values. Every
// import spelling shares one interned closure per runtime function, values
// flow through containers and user callbacks, and array HOFs call them with
// the declared prefix of JavaScript's callback arguments.
import { dirname, extname, isAbsolute, normalize, relative, toNamespacedPath } from "node:path";
import * as path from "node:path";
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";

const ext = extname;
const extAgain = ext;
const paths = ["/tmp/a.ts", "relative.js", "/root/readme"];
console.log(paths.map(extname).join("|"));
console.log(paths.filter(isAbsolute).join("|"));
console.log(ext === extname, extAgain === path.extname, typeof ext);

function apply1(fn: (value: string) => string, value: string): string {
  return fn(value);
}

function apply2(fn: (left: string, right: string) => string, left: string, right: string): string {
  return fn(left, right);
}

console.log(apply1(dirname, "/a/b/c.ts"));
console.log(apply2(relative, "/a/b", "/a/c/d"));
console.log(apply1(toNamespacedPath, "/tmp/example"));

const stored: ((value: string) => string)[] = [normalize, dirname, extname];
console.log(stored.map((fn) => fn("a//b/../file.ts")).join("|"));

let mutable: (value: string) => string = extname;
console.log(mutable("archive.tar.gz"));
mutable = dirname;
console.log(mutable("/one/two/three.txt"));

const operations: {
  normalize: (value: string) => string;
  extname: (value: string) => string;
} = { normalize: path.normalize, extname: path.extname };
console.log(operations.normalize("a//b/../c"), operations.extname("index.test.ts"));

function choose(flag: boolean): (value: string) => string {
  return flag ? normalize : dirname;
}

function wrap(fn: (value: string) => string): (value: string) => string {
  return (value) => fn(value);
}

console.log(choose(true)("a//b/../c"), choose(false)("/a/b/c"));
console.log(wrap(extname)("wrapped.test.ts"));

console.log(path.extname === extname);
console.log(path.posix.extname === posix.extname, path.win32.extname === win32.extname);
console.log(apply1(path.posix.normalize, "a//b/../c"));
console.log(apply2(win32.relative, "C:\\a\\b", "C:\\a\\c\\d"));
