// @ts-nocheck
// @rust-only
// @no-engine
export {};
let current: string | undefined = "ABC";
let effects = 0;
function change(): number { current = undefined; effects++; return 0; }
console.log("saved", current!.toLowerCase(change()), effects, current === undefined);
function absent(): string | undefined { effects++; return undefined; }
try { absent()!.toUpperCase(change()); }
catch (error) { console.log(error instanceof TypeError, String(error.message), effects); }
