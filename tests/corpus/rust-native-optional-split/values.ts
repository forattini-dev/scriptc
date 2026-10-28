// @rust-only
// @no-engine
export {};
let calls = 0;
function separator(): string { calls++; return ","; }
function split(value: string | null): string {
  const parts = value?.split(separator());
  if (parts === undefined) return "missing";
  return parts.join("|");
}
console.log("missing", split(null), calls);
console.log("present", split("a,b"), calls);
function versions(value: string): string {
  const result = value.match(/^-(\d+(?:[-.]\d+)*)/)?.[1]?.split(/[-.]/) ?? [];
  return result.join("|");
}
console.log("versions", versions("-4-8"), versions("none"));
function size(value: string | undefined): number {
  return value?.split(",").length ?? -1;
}
console.log("size", size(undefined), size("a,b"), calls);
