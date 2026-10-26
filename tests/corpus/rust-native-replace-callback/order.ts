// @ts-nocheck
let trace = "";
const regex = /a/g;
function receiver(): string { trace = trace + "S"; return "ab"; }
function search(): RegExp { trace = trace + "R"; return regex; }
function replacement() { trace = trace + "F"; return (match: string) => { trace = trace + "C"; return match.toUpperCase(); }; }
function extra(): number { trace = trace + "E"; return 1; }
console.log("order", receiver().replace(search(), replacement(), extra()), trace);
trace = "";
try { receiver().replaceAll(/a/, replacement(), extra()); }
catch (error) { console.log("guard", error instanceof TypeError, trace); }
console.log("all", "aba".replaceAll(regex, () => "X"));
