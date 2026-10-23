// @rust-only
// @no-engine
function primitives(): void {
  let count!: number;
  let label!: string;
  let flag!: boolean;
  console.log("initial", String(count), String(label), String(flag));
  count = 0;
  label = "";
  flag = false;
  console.log("assigned", count + 2, label + "ok", !flag);
  count = 9;
  console.log("reassigned", count + 1);
}
function containers(): void {
  let values!: number[];
  let record!: { count: number };
  console.log("containers", values === undefined, record === undefined);
  values = [3, 4];
  record = { count: 8 };
  console.log("owned", values.length, values[1], record.count);
}
function callbacks(): void {
  let callback!: () => number;
  try { callback(); }
  catch (error) { console.log("empty callback", (error as Error).message); }
  callback = () => 7;
  console.log("callback", callback());
}
primitives();
containers();
callbacks();
