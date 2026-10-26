// @rust-only
// @no-engine
let cell: string | undefined;
function clear(): boolean { console.log("clear"); cell = undefined; return true; }
function run(input: string): void {
  cell = /\[(.*)\]/.exec(input)?.[1];
  if (cell && clear()) console.log("after condition", cell === undefined);
  cell = /\[(.*)\]/.exec(input)?.[1];
  if (cell) {
    clear();
    console.log("after body", cell === undefined);
  }
  if (!cell) console.log("absent", cell === undefined);
}
run("[value]");
run("[]");
run("none");
function snapshot(input: string): string {
  const alias = /\[(.*)\]/.exec(input)?.[1];
  if (!alias) return "missing";
  clear();
  return alias.trim();
}
console.log("snapshot", snapshot("[ value ]"), snapshot("[]"), snapshot("none"));
