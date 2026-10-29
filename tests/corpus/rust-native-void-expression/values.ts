let count = 0;
function effect(): number {
  count += 1;
  return count;
}
function fail(): number {
  throw new Error("void-error");
}
console.log("value", typeof (void effect()), count, void 0 === undefined);
console.log("units", typeof (void undefined), typeof (void null), typeof (void (void effect())));
void console.log("discard void return");
console.log("order", typeof (void effect()), count, typeof (void effect()), count);
try {
  void fail();
} catch (error) {
  console.log("caught", (error as Error).message);
}
