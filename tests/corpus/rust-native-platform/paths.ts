// @rust-only
// @no-engine
import path from "node:path";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import { join as posixJoin } from "node:path/posix";
import { join as winJoin } from "node:path/win32";
import { homedir, tmpdir, platform, totalmem } from "node:os";
import { cwd, arch } from "node:process";
console.log("platform", platform() === process.platform, arch === process.arch);
console.log("directories", path.isAbsolute(cwd()), path.isAbsolute(tmpdir()), homedir().length > 0);
console.log("memory", Number.isFinite(totalmem()), totalmem() > 0);
console.log("posix", posix.join("/a", "b", "..", "c"), posix.normalize("a//b/../c"), posix.dirname("/a/b.txt"));
console.log("parts", posix.basename("/a/b.txt"), posix.basename("/a/b.txt", ".txt"), posix.extname("/a/b.txt"));
console.log("relative", posix.relative("/a/b", "/a/c/d"), posix.isAbsolute("/x"), posix.resolve("/a", "b", "..", "c"));
console.log("win", win32.join("C:\\a", "b", "..", "c"), win32.normalize("C:\\a\\..\\b"), win32.dirname("C:\\a\\b.txt"));
console.log("win parts", win32.basename("C:\\a\\b.txt"), win32.basename("C:\\a\\b.txt", ".txt"), win32.extname("C:\\a\\b.txt"));
console.log("win relative", win32.relative("C:\\a\\b", "C:\\a\\c\\d"), win32.isAbsolute("C:\\x"), win32.resolve("C:\\a", "b", "..", "c"));

console.log("named flavors", posixJoin("/a", "b"), winJoin("C:\\a", "b"));
