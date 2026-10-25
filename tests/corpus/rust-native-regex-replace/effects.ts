// @ts-nocheck
// @rust-only
// @no-engine
let trace = "";
const pattern = /a/g;
function subject(): string { trace = trace + "s"; return "aba"; }
function search(): RegExp { trace = trace + "p"; return pattern; }
function replacement(): string { trace = trace + "r"; return "x"; }
function ignored(): void { trace = trace + "i"; }
function fail(label: string): string { trace = trace + label; throw new Error(label); }
console.log("ordered", subject().replace(search(), replacement(), ignored()), trace);
trace = "";
console.log("all ordered", subject().replaceAll(search(), replacement(), ignored()), trace);
trace = "";
try { subject().replace(search(), fail("x"), ignored()); }
catch (error) { console.log("replacement throws", error instanceof Error, trace); }
trace = "";
try { subject().replace(search(), replacement(), fail("x")); }
catch (error) { console.log("extra throws", error instanceof Error, trace, pattern.lastIndex); }
trace = "";
try { fail("x").replace(search(), replacement()); }
catch (error) { console.log("subject throws", error instanceof Error, trace); }
trace = "";
try { subject().replaceAll(/a/, replacement(), ignored()); }
catch (error) { console.log("check after arguments", error instanceof TypeError, trace); }
console.log("primitive replacements", "aba".replace(/a/g, 12), "aba".replace(/a/g, null), "aba".replace(/a/g, true), "aba".replace(/a/g));
