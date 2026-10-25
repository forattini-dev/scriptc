// @rust-only
// @no-engine
// @ts-nocheck
export {};
interface View {known: number}
function read(view: View, key: string) { return view[key]; }
const child = {value: 1};
const full = {known: 7, extra: child};
console.log("view", read(full, "known") === 7, read(full, "extra") === child, read(full, "absent") === undefined);
child.value = 9;
console.log("alias", read(full, "extra").value === 9);
const callback = (value: number): number => value + 1;
const data = {known: 4, callback};
console.log("callback", read(data, "callback") === callback);
const fn = read(data, "callback");
console.log("call", fn(7) === 8);
