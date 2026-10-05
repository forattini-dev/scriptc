// @no-engine
class DisplayError extends Error {
  toString() { return "prototype"; }
}
class PlainError extends Error {}
function show(value) {
  console.log(String(value));
  console.log(`${value}`);
}
function ownHook(value) {
  value.toString = () => "own";
  value.valueOf = () => "unused";
}
function mutate(value) { value.name = "Renamed"; value.message = "changed"; }
show(new DisplayError("ignored"));
const custom = new DisplayError("ignored");
ownHook(custom);
show(custom);
const builtin = new Error("initial");
mutate(builtin);
show(builtin);
const plain = new PlainError("initial");
mutate(plain);
show(plain);
