// @dynamic
import { capture } from "throws";

console.log(capture(() => { throw "boom"; }));
console.log(capture(() => { throw 42; }));
console.log(capture(() => { throw false; }));
console.log(capture(() => { throw -0; }));
console.log(capture(() => { throw NaN; }));
console.log(capture(() => { throw Infinity; }));
console.log(capture(() => { throw new RangeError("host range"); }));
