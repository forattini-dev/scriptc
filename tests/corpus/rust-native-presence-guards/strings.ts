// @rust-only
// @no-engine
function required(input: string): string {
  const alias = /^\{(.*)\}$/.exec(input)?.[1];
  if (!alias) throw new Error("missing alias");
  return alias.trim();
}
console.log("present", required("{ token }"));
for (let index = 0; index < 3; index = index + 1) {
  const input = index === 0 ? "{}" : index === 1 ? "none" : "{ value }";
  try { console.log("loop", index, required(input)); }
  catch (error) { if (error instanceof Error) console.log("missing", index, error.message); else throw error; }
}
function choose(input: string): string {
  const alias = /\[(.*)\]/.exec(input)?.[1];
  if (alias) return alias.toUpperCase();
  return "fallback";
}
console.log("truthy", choose("[value]"), choose("[]"), choose("none"));
function numeric(index: number): number {
  const value: number | undefined = index === 0 ? 0 : index === 1 ? undefined : index === 2 ? 7 : 0 / 0;
  if (!value) return -1;
  return value + 1;
}
function boolean(index: number): string {
  const value: boolean | undefined = index === 0 ? false : index === 1 ? undefined : true;
  if (!value) return value === undefined ? "absent" : "false";
  return "true";
}
console.log("numeric", numeric(0), numeric(1), numeric(2), numeric(3));
console.log("boolean", boolean(0), boolean(1), boolean(2));
