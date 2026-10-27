// @rust-only
// @no-engine
let cell: string | undefined;
function clear(): boolean { console.log("clear"); cell = undefined; return true; }
function inspect(input: string): void {
  cell = /\[(.*)\]/.exec(input)?.[1];
  console.log("truthy", cell ? cell.trim() : "absent");
  console.log("inverted", !cell ? "empty or absent" : cell.toUpperCase());
  console.log("undefined", cell === undefined ? "missing" : cell.trim());
  console.log("defined", cell !== undefined ? cell.trim() : "missing");
  console.log("compound", cell && clear() ? "cleared" : "unchanged");
  try { console.log("after condition", cell!.trim()); }
  catch (error) { console.log("after condition error", error instanceof TypeError); }
  cell = /\[(.*)\]/.exec(input)?.[1];
  console.log("branch", cell !== undefined ? clear() : false);
  try { console.log("after branch", cell!.trim()); }
  catch (error) { console.log("after branch error", error instanceof TypeError); }
}
inspect("[ value ]"); inspect("[]"); inspect("none");
function captured(input: string): string {
  const alias = /\[(.*)\]/.exec(input)?.[1];
  return alias ? (clear() ? alias.trim() : "wrong") : "missing";
}
console.log("snapshot", captured("[ stable ]"), captured("[]"), captured("none"));
