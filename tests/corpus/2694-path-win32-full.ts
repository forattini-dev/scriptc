// The full path.win32 pure-string family. These operations use Windows
// semantics on every host: both slash spellings are separators, drive and
// UNC roots are retained, comparisons are case-insensitive, and long-path
// conversion produces the Win32 namespace prefixes.
import * as path from "node:path";

console.log("normalize", path.win32.normalize("C:/temp//foo/../bar/"));
console.log("normalize-unc", path.win32.normalize("\\\\server\\share\\foo\\..\\"));
console.log("normalize-above", path.win32.normalize("a\\..\\..\\b"));
console.log("normalize-empty", path.win32.normalize(""));

console.log("resolve-drive", path.win32.resolve("C:\\base\\dir", "..\\file.txt"));
console.log("resolve-unc", path.win32.resolve("\\\\server\\share\\base", "..\\file"));
console.log("resolve-rightmost", path.win32.resolve("D:\\left", "C:\\right"));

console.log("absolute", path.win32.isAbsolute("C:\\base"), path.win32.isAbsolute("C:base"));
console.log("absolute-root", path.win32.isAbsolute("\\root"), path.win32.isAbsolute("relative"));

console.log("relative", path.win32.relative("C:\\a\\b", "C:\\a\\c\\d"));
console.log("relative-case", path.win32.relative("C:\\A\\B", "c:\\a\\b"));
console.log("relative-drive", path.win32.relative("C:\\a", "D:\\b"));

console.log("dirname", path.win32.dirname("C:\\a\\b\\file.txt"));
console.log("dirname-unc", path.win32.dirname("\\\\server\\share\\a\\b.txt"));
console.log("dirname-root", path.win32.dirname("C:\\"));

console.log("basename", path.win32.basename("C:\\a\\file.txt"));
console.log("basename-suffix", path.win32.basename("C:\\a\\file.txt", ".txt"));
console.log("basename-trailing", path.win32.basename("C:\\a\\dir\\"));

for (const value of ["C:\\a\\file.txt", "C:\\a\\file.", ".profile", "..", "C:\\a\\archive.tar.gz"]) {
  console.log("ext", value, path.win32.extname(value));
}

console.log("namespace-drive", path.win32.toNamespacedPath("C:\\a\\b"));
console.log("namespace-unc", path.win32.toNamespacedPath("\\\\server\\share\\a"));
console.log("namespace-existing", path.win32.toNamespacedPath("\\\\?\\C:\\a"));
