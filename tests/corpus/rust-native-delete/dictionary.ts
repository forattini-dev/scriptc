// @rust-only
// @no-engine
export {};
function keys(value: any): string { return Object.keys(value).join(","); }
function own(value: any, key: string): boolean { return Object.hasOwn(value, key); }
function check(data: Record<string, number>): void {
  const alias = data;
  console.log("dictionary", delete data.x, delete data.absent, keys(alias), own(alias, "x"));
}
check({x: 1, y: 2});
