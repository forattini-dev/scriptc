// @rust-only
// @no-engine
export {};
function alias(value: string): string | undefined {
  return /^\{(.+)\}$/.exec(value.trim())?.[1];
}
console.log(alias(" {colour.red} ") === "colour.red", alias("red") === undefined);
console.log(/(a)?b/.exec("b")?.[1] === undefined, /b/.exec("b")?.[99] === undefined);
let effects = 0;
function key(): number { effects++; return 0; }
console.log(/a/.exec("b")?.[key()] === undefined, effects);
console.log(/a/.exec("a")?.[key()] === "a", effects);
function indexed(value: number[] | null | undefined): number | undefined { return value?.[key()]; }
console.log(indexed(undefined) === undefined, indexed(null) === undefined, effects);
console.log(indexed([]) === undefined, indexed([7]) === 7, effects);
function size(value: string[] | undefined): number | undefined { return value?.length; }
console.log(size(undefined) === undefined, size([]) === 0, size(["a"]) === 1);
