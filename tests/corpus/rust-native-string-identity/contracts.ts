// @rust-only
// @no-engine
function identity(value: string): string {
  return (value.toString()).valueOf();
}
console.log("strings", identity(""), identity("text"), "literal".valueOf());
const original = "A😀" + "😀".slice(1) + "Z";
const copied = identity(original);
console.log("utf16", copied === original, copied.length, copied.charCodeAt(1), copied.charCodeAt(2), copied.charCodeAt(3));
const record = { value: copied.toString() };
const array = [record.value.valueOf(), "other".toString()];
function capture(value: string): () => string {
  return () => value.valueOf();
}
const read = capture(array[0]);
console.log("storage", record.value === original, array[0] === original, read() === original, array[1]);
function optional(value?: string): string {
  if (value === undefined) return "missing";
  return value.toString();
}
console.log("optional", optional(), optional("present"));
