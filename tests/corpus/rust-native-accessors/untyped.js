// @rust-only
// @no-engine
class Box {
  stored = 3;
  get value() { return this.stored; }
  set value(next) { this.stored = next; }
}
const box = new Box();
console.log("js", box.value, (box.value = 8), box.value);
