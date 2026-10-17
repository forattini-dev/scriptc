// @rust-only
// @no-engine
export {};
class Box {
  name = 17;
  message = true;
  value: string;
  peer: Box | undefined;
  constructor(value: string) { this.value = value; }
}
const first = new Box("first");
const second = new Box("second");
first.peer = second;
second.peer = first;
const alias = first;
const stored = [first, second];
console.log("fields", first.name, first.message, first.value, second.value);
console.log("identity", alias === first, first !== second, stored[0] === first, first.peer === second);
console.log("hierarchy", first instanceof Box, first instanceof Error);
function capture(box: Box): () => Box { return () => box; }
console.log("closure", capture(first)() === first);
const Constructor = Box;
console.log("constructor", Constructor === Box, new Constructor("third").value);
function isBox(value: unknown): boolean { return value instanceof Box; }
console.log("unknown", isBox(first), isBox({ value: "plain" }), isBox(1), isBox(null), isBox(undefined));
