// @rust-only
// @no-engine
export {};
class Box {
  stored = 0;
  get value(): number { console.log("get"); return this.stored; }
  set value(value: number) {
    console.log("set", value);
    if (value < 0) throw new TypeError("rejected");
    this.stored = value;
  }
}
const box = new Box();
function receiver(): Box { console.log("receiver"); return box; }
function right(value: number): number { console.log("right", value); return value; }
console.log("result", (receiver().value = right(6)), box.stored);
console.log("read", receiver().value);
try { receiver().value = right(-1); }
catch (error) { if (error instanceof TypeError) console.log("caught", error.message); }
console.log("unchanged", box.stored);
class Throwing {
  get value(): number { console.log("throwing get"); throw new RangeError("getter failed"); }
}
try { console.log(new Throwing().value); }
catch (error) { if (error instanceof RangeError) console.log(error.message); }
