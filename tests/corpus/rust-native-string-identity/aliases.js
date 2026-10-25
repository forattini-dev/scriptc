// @rust-only
// @no-engine
function describe(val) {
  const alias = val;
  const isText = typeof alias === "string";
  if (isText) return alias.toString() + "n";
  return "other";
}
console.log("guard", describe("123"), describe(123), describe(""));
function value(val) {
  if (typeof val === "string") return val.valueOf();
  return "other";
}
console.log("js valueOf", value("yes"), value(null));
