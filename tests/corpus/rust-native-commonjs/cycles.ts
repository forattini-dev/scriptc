import a from "./cjs/cycle-a.js";
import b from "./cjs/cycle-b.js";
console.log("cycles", a.phase === "done", a.saw === "starting", b.a === a);
