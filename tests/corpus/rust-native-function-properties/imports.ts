import { auth, inspect, update } from "./module.ts";
const alias = auth;
console.log("module", alias.VERSION === "first", inspect() === "first", alias(4));
update("second");
console.log("mutation", alias.VERSION === "second", inspect() === "second", alias === auth);
alias.VERSION = "third";
console.log("return", inspect() === "third");
