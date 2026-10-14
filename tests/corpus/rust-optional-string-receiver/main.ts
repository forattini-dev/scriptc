// @no-engine
function inspect(src: string | undefined, index: number): void {
  try { console.log("read", src![index] ?? "missing"); }
  catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
}
const texts: string[] = [];
inspect(texts[0], 2);
inspect("abc", 1);
inspect("abc", -1);
inspect(texts[0], NaN);

function snapshot(present: boolean, next: boolean, throws: boolean): void {
  let source = present ? "before" : texts[0];
  function key(): number {
    console.log("key", typeof source);
    source = next ? "after" : texts[0];
    if (throws) throw new Error("key failed");
    return 1;
  }
  function read(): void {
    try { console.log("snapshot", (source!)[key()] ?? "missing"); }
    catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
  }
  read();
  console.log("after", source ?? "missing");
}
snapshot(true, false, false);
snapshot(false, true, false);
snapshot(false, true, true);
snapshot(true, true, false);

let count = 0;
function index(): number { console.log("index", ++count); return 0; }
try { console.log((texts[0] as string)[index()]); }
catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
texts.push("xyz");
console.log("nested", (texts[0] as string)[index()]);
let optional: string | undefined = "kept";
function skipped(): number { console.log("unexpected"); return 0; }
optional = texts[99];
console.log("optional", optional?.[skipped()] === undefined);
