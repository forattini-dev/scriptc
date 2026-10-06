// util.isDate() is declared by the old-layout @types/node 24.13.3 this
// project resolves and by no later major: 26.1.2, the copy the program
// carries, dropped it. The error is honest, and its hint names both copies.
// The second statement is a plain type error the Node declarations cannot
// explain: it carries no hint.
import { isDate } from "node:util";
import { label } from "../lib/src/label.ts";

const when: Date = new Date(0);
console.log(label("removed"), isDate(when));
const count: number = label("mismatch");
console.log(count);
