// @rust-only
// @no-engine
export {};
function numbers(value: any): void {
  console.log("math", Math.max(1, value), Math.min(1, value), Math.abs(value), Math.trunc(value), Math.sqrt(value));
}
numbers(4); numbers("9"); numbers(true); numbers(false); numbers(null); numbers(undefined); numbers("bad"); numbers(-0); numbers(1 / 0);
function copied(value: any): number { const alias = value; return Math.max(1, alias); }
console.log("alias", copied("3"));
const options: {value: unknown} = {value: "5"};
console.log("field", Math.max(1, options.value as any));
function failure(value: any): void {
  try { Math.max(value, 1); }
  catch (error) { console.log("error", error instanceof TypeError); }
}
failure(1n); failure(Symbol("x"));
