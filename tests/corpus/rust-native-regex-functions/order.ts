// @rust-only
// @no-engine
// @ts-nocheck
let events = "";
const regex = /a/g;
function base(): RegExp { events = events + "base;"; return regex; }
function receiver(): RegExp { events = events + "this;"; return regex; }
function input(): string { events = events + "input;"; return "aa"; }
const bound = base().test.bind(receiver());
console.log("bind", events, regex.lastIndex);
console.log(bound(input()), events, regex.lastIndex);
const test = base().test;
try { test.call(null, input(), input()); } catch (error) { console.log(error instanceof TypeError, events); }
console.log(test.call(receiver(), input(), input()), events, regex.lastIndex);
const fixed = base().test.bind(receiver(), input());
console.log(fixed(), events, regex.lastIndex);
function fail(): RegExp { events = events + "throw;"; throw new Error("stop"); }
try { fail().test.bind(receiver()); } catch (error) { console.log(error instanceof Error, events); }
