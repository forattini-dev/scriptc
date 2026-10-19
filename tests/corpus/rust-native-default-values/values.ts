// @rust-only
// @no-engine
export {};
function missing(value: number | undefined = undefined): string { return typeof value; }
console.log("undefined", missing(), missing(undefined), missing(0));
function nullable(value: string | null = null): boolean { return value === null; }
console.log("null", nullable(), nullable(undefined), nullable(null));
function record(value: { count: number } | undefined = undefined): number {
  if (value === undefined) return -1;
  return value.count;
}
function array(value: number[] | undefined = undefined): number {
  if (value === undefined) return -2;
  return value[0];
}
console.log("containers", record(), record({ count: 3 }), array(), array([4]));
function callback(value: (() => number) | undefined = undefined): number {
  if (value === undefined) return -3;
  return value();
}
function callable(value: () => number = () => 6): number { return value(); }
console.log("callbacks", callback(), callback(() => 5), callable());
