/// <reference types="node" />
import { posix, win32 } from "node:path";

console.log(win32.isAbsolute("C:\\native"), win32.isAbsolute("relative"));
console.log(posix.isAbsolute("/native"), posix.isAbsolute("relative"));
