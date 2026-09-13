// @rust-only
interface Row { left: string; right: string }
function run(left: string, right: string): void {
  const row: Row = { left, right };
  const get = <K extends keyof Row>(key: K): Row[K] => row[key];
  console.log(get("left"), get("right"), get("left"));
  const invoke = (): string => get("right");
  console.log(invoke());
}
run("L", "R");
run("other L", "other R");
