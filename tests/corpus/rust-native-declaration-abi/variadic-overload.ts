import { combine } from "variadic-declaration";
console.log("empty", String(combine("x")));
console.log("values", String(combine("x", "a", "b")));
const parts = ["one", "two"];
console.log("spread", String(combine("x", ...parts)));
console.log("source", parts.join("|"));
