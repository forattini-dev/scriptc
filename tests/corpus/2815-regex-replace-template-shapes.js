// The replacement values that DO lower, next door to the FUNCTION
// replacements the checker-level gate now fences (tests/diagnostics/
// regex-function-replacement.js): templates, a string local, a computed
// string. A JavaScript source is the interesting flavor — here a builtin
// taken as a value becomes an opaque string token, which is exactly why
// the gate reads the checker type and not the lowered one; none of these
// arguments is callable, so none may fence.
function pct() {
  return "%20";
}
const raw = "/a b/c?d=e f";
// The direct call — what a function replacement has to be rewritten into.
console.log(encodeURI(raw));
console.log(raw.replace(/ /g, "%20"));
console.log(raw.replace(/ /g, pct()));
const sep = "_";
console.log("x y z".replaceAll(/ /g, sep));
console.log("a=1&b=2".replace(/([a-z])=(\d)/g, "$1:$2"));
console.log("a b".replace(" ", `[${sep}]`));
console.log("a b c".replaceAll(" ", sep));
