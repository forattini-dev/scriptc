// @rust-only
// @no-engine
function read(): void { console.log("read", memo === undefined); }
function value(): string { console.log("rhs"); return "early"; }
function write(): void { memo = value(); }
try { read(); } catch (error) { console.log("read TDZ", (error as Error).message); }
try { write(); } catch (error) { console.log("write TDZ", (error as Error).message); }
console.log("before declaration");
let memo: string | undefined;
console.log("after declaration");
read();
write();
console.log("written", memo === "early");
