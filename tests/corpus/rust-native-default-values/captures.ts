// @rust-only
// @no-engine
export {};
function counter(value: number | undefined = undefined): () => number {
  return () => { if (value === undefined) value = 0; value = value + 1; return value; };
}
const next = counter();
console.log("captured", next(), next());
const inspect = (value: number | undefined = undefined): string => typeof value;
const alias = inspect;
console.log("alias", alias(), alias(7));
const expression = function(value: boolean | undefined = undefined): string { return typeof value; };
console.log("expression", expression(), expression(false));
class Box {
  value: string;
  constructor(value: string | undefined = undefined) { this.value = value === undefined ? "empty" : value; }
  read(value: number | undefined = undefined): string { return typeof value; }
}
const box = new Box();
console.log("class", box.value, box.read(), new Box("set").value, box.read(3));
