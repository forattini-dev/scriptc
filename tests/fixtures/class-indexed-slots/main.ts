import { Counter } from "./counter.js";
const counter = new Counter("one");
const alias = counter;
console.log("initial", counter["~name"], alias["~count"]);
counter.bump();
alias["~name"] = "two";
console.log("updated", counter["~name"], counter["~count"], counter === alias);
