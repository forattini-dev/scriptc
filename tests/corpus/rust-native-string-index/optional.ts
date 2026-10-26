// @rust-only
// @no-engine
export {};
let calls = 0;
function key(): number { calls++; return 0; }
function read(value: string | null | undefined): void {
  console.log("optional", value?.[key()] ?? "missing", value?.length ?? -1);
}
read("abc"); read(""); read(null); read(undefined);
console.log("calls", calls);
function chain(value: string | null): number | undefined { return value?.[0]?.length; }
console.log("chain", chain("ab") === 1, chain("") === undefined, chain(null) === undefined);
