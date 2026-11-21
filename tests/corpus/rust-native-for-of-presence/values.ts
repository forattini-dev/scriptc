function typed(value: string | undefined, items: number[]): void {
  const snapshot = value;
  if (snapshot === undefined) return;
  for (const item of items) {
    console.log("typed", item, snapshot.length);
  }
  console.log("after", snapshot.length);
}
function erased(value: string | undefined, items: any): void {
  const snapshot = value;
  if (snapshot === undefined) return;
  for (const item of items) {
    console.log("erased", snapshot.length);
  }
  console.log("after-erased", snapshot.length);
}
function mutable(): void {
  let value: string | undefined = "present";
  const clear = (): void => { value = undefined; };
  for (const item of [1, 2]) {
    if (item === 1) clear();
    console.log("mutable", value === undefined);
  }
}
typed("hello", [1, 2]);
typed("empty", []);
typed(undefined, [1]);
erased("world", [3]);
erased("zero", []);
mutable();

function assignedBeforeLoop(items: number[]): void {
  let value: number;
  try {
    value = Number("2");
  } catch {
    return;
  }
  for (const item of items) {
    console.log("assigned-loop", value + item);
    value = value + item;
  }
  console.log("assigned-after", value);
}
assignedBeforeLoop([1, 2]);


