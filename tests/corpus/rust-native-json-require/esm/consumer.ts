import { read } from "../bridge.js";
const first = read();
const second = read();
console.log("producer", first === second, first.nested.answer === 42, (first.rows as any)[2][1] === "text");
const values: number[] = [3,4];
const mapped = values.map((value: number): number => value * 2);
console.log("typed-array", mapped[0] === 6, mapped[1] === 8);
