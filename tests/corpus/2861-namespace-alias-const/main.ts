import { Event, Same, describe } from "./alias.ts";

console.log(Event.Connected, Event.Disposed);
console.log(Event.define("x"), Same.define("y"));
console.log(describe());
const record = (ns: { Connected: string; define(t: string): string }): string => ns.define(ns.Connected);
console.log(record(Event));
