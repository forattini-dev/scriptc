// @ts-nocheck
// @rust-only
// @no-engine
let trace = "";
function text(): string { trace = trace + "t"; return "ff"; }
function radix(): number { trace = trace + "r"; return 16; }
function extra(): number { trace = trace + "e"; return 99; }
console.log("direct", Number.parseInt(text(), radix(), extra()), trace);
trace = "";
console.log("float", Number.parseFloat(text(), radix(), extra()), trace);
trace = "";
function fail(): number { trace = trace + "x"; throw new Error("argument"); }
try { Number.parseInt(text(), fail(), extra()); }
catch (error) { console.log("argument error", trace, String(error.message)); }
trace = "";
function symbol(): symbol { trace = trace + "s"; return Symbol("input"); }
try { Number.parseInt(symbol(), radix(), extra()); }
catch (error) { console.log("conversion error", trace, error instanceof TypeError, String(error.message)); }
trace = "";
try { Number.parseInt(symbol(), 2n, extra()); }
catch (error) { console.log("text before radix", trace, String(error.message)); }
