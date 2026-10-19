// @rust-only
// @no-engine
export {};
function read() { return cache; }
function rhs() { console.log("rhs"); return "written"; }
function write() { cache = rhs(); }
try { read(); } catch (error) { console.log("read TDZ", error.message === "Cannot access 'cache' before initialization"); }
try { write(); } catch (error) { console.log("write TDZ", error.message === "Cannot access 'cache' before initialization"); }
console.log("before declaration");
let cache = (null);
console.log("initialized", read() === null);
write();
console.log("after write", read() === "written");
cache = null;
console.log("reset", read() === null);
