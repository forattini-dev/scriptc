// @rust-only
// @no-engine
export {};
function suffix(value: string): string {
  const match = /^(\d+)([KMGT]?)$/i.exec(value);
  if (!match) return "invalid";
  return match[2]!.toLowerCase();
}
console.log("suffix", suffix("12K"), suffix("8"), suffix("bad"));
function normal(value: string | undefined): string { return value!.trim().toUpperCase(); }
console.log("normal", normal(" mixed "));
