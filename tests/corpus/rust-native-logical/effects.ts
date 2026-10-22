// @rust-only
// @no-engine
let trace = "";
function left(value: number): number { trace = trace + "L"; return value; }
function right(): string { trace = trace + "R"; return "right"; }
console.log("pick", `${left(0) && right()}`, trace); trace = "";
console.log("pick", `${left(1) && right()}`, trace); trace = "";
console.log("pick", `${left(0) || right()}`, trace); trace = "";
console.log("pick", `${left(1) || right()}`, trace);
function fail(): string { trace = trace + "X"; throw new Error("chosen"); }
console.log("skipped", (false && fail()) === false, (true || fail()) === true);
try { left(1) && fail(); } catch (error) { console.log("throw", (error as Error).message); }
console.log("after", trace);
try { throw 0; } catch (error) { console.log("caught-zero", `${error || "fallback"}`, typeof (error && "unused")); }
try { throw {value: 5}; } catch (error) { console.log("caught-object", (error && true) === true); }
try { throw "kept"; } catch (error) { console.log("caught-string", `${error || "fallback"}`); }
