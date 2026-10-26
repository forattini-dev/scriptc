// @rust-only
// @no-engine
// @ts-nocheck
export {};
let log = "";
function mark(label: string, value: any): any { log = log + label; return value; }
console.log("number", Number(mark("a", "12"), mark("b", 9)), log);
log = "";
try { Number(mark("a", Symbol("bad")), mark("b", 9)); }
catch (error) { console.log("symbol", error instanceof TypeError, String(error.message), log); }
log = "";
function fail(): any { log = log + "b"; throw new Error("later"); }
try { Number(mark("a", Symbol("bad")), fail()); }
catch (error) { console.log("later", String(error.message), log); }
const convert = Number;
log = "";
console.log("receiver", convert.call(mark("r", {ignored: true}), mark("v", "33"), mark("x", 0)), log);
