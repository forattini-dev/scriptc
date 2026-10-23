// @ts-nocheck
// @rust-only
// @no-engine
// The runtime surface remains usable from JavaScript with older lib declarations.
const raw = JSON.rawJSON("9007199254740993123");
console.log("plain", JSON.stringify(raw) === "9007199254740993123", JSON.isRawJSON(raw) === true, raw.rawJSON === "9007199254740993123");
function shadowed() {
  const JSON = { rawJSON: value => "local:" + value, isRawJSON: value => value === "local" };
  return JSON.rawJSON("3") === "local:3" && JSON.isRawJSON("local");
}
console.log("shadow", shadowed());
