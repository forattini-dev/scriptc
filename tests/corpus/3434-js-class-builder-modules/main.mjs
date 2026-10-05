import { command } from "./factory.mjs";
class First extends command({ name: "first" }) {}
class Second extends command({ name: "second" }) {}
const first = new First(7);
const second = new Second(9);
console.log(first.read(), second.read(), first.command() === second.command());
First.configuration().name = "changed";
console.log(first.read(), second.read(), first.command().name);
