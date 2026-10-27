// @rust-only
// @no-engine
// @ts-nocheck
export {};
function moduleLength(): number { return Number(length); }
const { length, 0: first, 1: high, 2: low, 9: absent } = "a😀";
console.log("string", Number(length), String(first), String(high).charCodeAt(0), String(low).charCodeAt(0), absent === undefined);
console.log("module-capture", moduleLength());
const { missing: numeric } = 12;
const { missing: boolean } = false;
const { missing: bigint } = 3n;
const { description } = Symbol("label");
console.log("boxed", numeric === undefined, boolean === undefined, bigint === undefined, String(description));
function empty(source: any): void { const {} = source; console.log("empty-ok"); }
empty(0); empty(false); empty(3n); empty("text"); empty(Symbol("empty"));
function checked(source: any, emptyPattern: boolean): void {
  try {
    if (emptyPattern) { const {} = source; }
    else { const { value } = source; console.log("unexpected", String(value)); }
    console.log("unexpected-success");
  } catch (error) { console.log("nullish", emptyPattern, error instanceof TypeError); }
}
checked(null, true); checked(undefined, true);
checked(null, false); checked(undefined, false);
