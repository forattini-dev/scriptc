// @rust-only
// @no-engine
export {};
function parse(value: string): number {
  const match = /^(\d+)([km]?)$/i.exec(value);
  if (!match) return -1;
  const unit = match[2]!.toLowerCase();
  return Math.round(Number(match[1]) * (unit === "k" ? 1024 : unit === "m" ? 1048576 : 1));
}
console.log("capture-receiver", parse("4K"), parse("5"), parse("2m"), parse("bad"));
