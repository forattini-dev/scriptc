// @rust-only
// @no-engine
const value = { toString(): string { return "custom"; } };
class Custom { toString(): string { return "instance"; } }
function local(): string {
  const JSON = { parse: { toString(): string { return "local parse"; } } };
  return JSON.parse.toString();
}
console.log("shadows", value.toString(), new Custom().toString(), local(), "string".toString());
