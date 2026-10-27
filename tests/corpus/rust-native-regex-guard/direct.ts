// @rust-only
// @no-engine
export {};
function useCapture(value: string): string { return value.toUpperCase(); }
function extract(value: string): string {
  const match = /^(a)?b$/.exec(value);
  const alias = match;
  if (alias?.[1] === undefined) { throw new Error("absent"); }
  return useCapture(alias[1]);
}
console.log(extract("ab"));
try { console.log(extract("b")); } catch (error) { console.log("missing"); }
try { console.log(extract("x")); } catch (error) { console.log("no match"); }
