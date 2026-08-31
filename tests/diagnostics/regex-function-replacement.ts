// A replacement FUNCTION is called once per match; nothing lowers that, so
// every spelling must fence — and the gate has to read the CHECKER type,
// not the lowered one. A builtin taken by reference lowers to an opaque
// identity token (a STRING literal in the JS lane), which a string-typed
// check waves through: `url.replace(re, encodeURI)` — the `encodeurl`
// package's core — used to INTERPOLATE "[builtin encodeURI]" instead of
// encoding. The JS lane's deferred spelling of these lives in
// errors.test.ts ("function replacement values"); here tsc's own lane
// pins the compile-time fence for each argument shape.
const direct = "a b".replace(/ /g, encodeURI);
const captures = "a=1".replace(/([a-z])=(\d)/g, encodeURIComponent);
const all = "a b c".replaceAll(/ /g, encodeURIComponent);
const stringPattern = "a b".replace(" ", encodeURIComponent);
const named = "a b".replace(/[ab]/g, function up(m: string): string {
  return m.toUpperCase();
});
console.log(direct, captures, all, stringPattern, named);
