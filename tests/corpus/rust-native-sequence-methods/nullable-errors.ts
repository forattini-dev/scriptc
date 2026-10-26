// @ts-nocheck
// @rust-only
// @no-engine
export {};
let effects = 0;
function extra(): number { effects++; return 0; }
function read(value: string | null | undefined): void {
  try { console.log("value", value!.toLowerCase(extra()), effects); }
  catch (error) { console.log(error instanceof TypeError, String(error.message), effects); }
}
read(undefined); read(null); read("ABC");
const match = /(a)?b/.exec("b");
if (match !== null) {
  try { match[1]!.toLowerCase(extra()); }
  catch (error) { console.log(error instanceof TypeError, String(error.message), effects); }
}
