// @rust-only
// @no-engine
import { Calculator, Box } from "./library.mjs";
const calculator = new Calculator(5);
console.log("public", calculator.add(), calculator.add(3), calculator.value);
calculator.clear();
console.log("void", calculator.value);
const data = { answer: 42 };
const record = new Box(data);
const scalar = new Box("scalar");
console.log("generic", record.get() === data, record.get().answer, scalar.get());
record.set({ answer: 7 });
scalar.set("changed");
console.log("set", record.get().answer, scalar.get());
const arrays = new Box([1, 2]);
console.log("array ctor", arrays.get()[0], arrays.get()[1]);
arrays.set([3, 4]);
console.log("array", arrays.get()[0], arrays.get()[1]);
