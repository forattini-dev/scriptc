// @rust-only
// @no-engine
let trace = "";
function note() { trace = trace + "v"; }
console.log("or", `${note() || "fallback"}`, trace);
console.log("and", `${note() && "unused"}`, trace);
console.log("right", `${true && note()}`, trace);
