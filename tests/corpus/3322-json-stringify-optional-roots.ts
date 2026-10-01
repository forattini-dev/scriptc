// @rust-only
// @no-engine
function encodeNumber(value: number | undefined): void {
  const text = JSON.stringify(value);
  console.log("number", text === undefined, text ?? "missing");
}
function encodeValue(value: number | boolean | null | undefined): void {
  const text = JSON.stringify(value);
  console.log("value", text === undefined, text ?? "missing");
}
function encodeRecord(value: { label: string } | undefined): void {
  const text = JSON.stringify(value, null, 2);
  console.log("record", text === undefined, text ?? "missing");
}
function returnOptional(value: number | undefined) {
  return JSON.stringify(value);
}
function encodeRuntimeSpacing(value: { label: string } | undefined, width: number): void {
  const text = JSON.stringify(value, null, width);
  console.log("runtime-spacing", text === undefined, text ?? "missing");
}
function encodeString(value: string | undefined): void {
  const text = JSON.stringify(value);
  console.log("string", text === undefined, text ?? "missing");
}
function encodeList(value: number[] | undefined): void {
  const text = JSON.stringify(value, null, 2);
  console.log("list", text === undefined, text ?? "missing");
}
encodeNumber(undefined);
encodeNumber(42);
encodeNumber(NaN);
encodeValue(undefined);
encodeValue(false);
encodeValue(null);
encodeValue(1);
encodeRecord(undefined);
encodeRecord({ label: "ok" });
console.log("returned", returnOptional(undefined) === undefined, returnOptional(42));
encodeRuntimeSpacing(undefined, 3);
encodeRuntimeSpacing({ label: "ok" }, 3);
encodeString(undefined);
encodeString("ç😀");
encodeList(undefined);
encodeList([1, 2]);
