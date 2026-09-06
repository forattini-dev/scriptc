// @dynamic
// @rust-only
// @island-module: ./clock.ts
// A native Date crossing into island code: the engine sees a Date at the
// same instant (a fresh object — identity does not cross).
import { describe } from "./clock.ts";

const when = new Date(Date.UTC(2026, 8, 6, 3, 4, 5, 6));
console.log(describe(when));
console.log(describe(new Date(0)));
