type Wide = { value: string; extra: string };
type Base = { value: string };
let trace = ""; const original: Wide = { value: "old", extra: "keep" };
function source(): Base { trace = trace + "source|"; return original; }
function last(): string { trace = trace + "last|"; original.value = "changed"; return "end"; }
function copy(): {value:string;last:string} { return { ...source(), last: last() }; }
const result = copy(); console.log("case", trace, result.value, original.value, Object.keys(result).join("|"));
function fail(): string { trace = trace + "throw|"; throw new Error("stop"); }
function broken(): {value:string;last:string} { return {...source(), last:fail()}; }
trace = ""; try { broken(); } catch { console.log("case", trace); }
