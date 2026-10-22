// @ts-nocheck
// @rust-only
// @no-engine
let trace = "";
function mark(value: string, result: number): number { trace = trace + value; return result; }
function text(value: string, result: string): string { trace = trace + value; return result; }
console.log("unary", Math.floor(mark("a", 2.9), mark("b", 4)), trace);
trace = "";
console.log("all", Math.min(mark("a", 0 / 0), mark("b", 1), mark("c", -2)), trace);
trace = "";
console.log("receiver", text("r", "xy").repeat(mark("n", 2), mark("e", 0)), trace);
console.log("missing", Math.floor(), Math.round(), "x".repeat());
console.log("primitives", Math.floor("2.9"), Math.ceil(true), Math.trunc(null), Math.abs(undefined), Math.min(" 0x10 ", 3, false), "x".repeat("2"));
console.log("erased assertions", Math.floor("2.9" as unknown as number), "x".repeat("2" as unknown as number), ("xy" as unknown as string).repeat(2));
