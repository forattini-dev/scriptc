const nativeNow = Date.now;
const first = nativeNow();
console.log("function", typeof first, Number.isFinite(first), first > 0);

const selectNow = (override?: () => number) => override ?? Date.now;
console.log("nullish", selectNow(() => 7)(), selectNow()() > 0);
