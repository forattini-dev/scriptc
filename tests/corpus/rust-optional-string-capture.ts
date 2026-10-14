// @no-engine
// The checker spells these bindings string; unchecked array reads still
// promote their runtime storage and call ABI to string | undefined.
const empty: string[] = [];
function inspect(src: string, i: number): void {
  try { console.log("read", src[i]); }
  catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
}
const inspectAlias = inspect;
inspectAlias(empty[0], 3);
inspectAlias("abc", 1);

let source = empty[0];
function key(): number {
  console.log("global key", source === undefined);
  source = "after";
  return -0;
}
try { console.log(source[key()]); }
catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
console.log("global after", source);

function capture(): void {
  let text = empty[0];
  function index(): number { console.log("captured key"); text = "changed"; return 2; }
  function read(): void {
    try { console.log(text[index()]); }
    catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
  }
  read();
  console.log("captured after", text);
}
capture();
