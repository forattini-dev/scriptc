// @rust-only
// @no-engine
// @npm-static: auto
import { defaults, slots, reset, trace, throwsDefault } from "native-rest-entry";
let events = "";
function argument(label: string, value: any): any { events = events + label; return value; }
function abrupt(): any { events = events + "X"; throw new Error("argument"); }
reset(); defaults(argument("1", undefined), argument("2", undefined), argument("3", undefined), argument("4", true));
console.log("order", events, trace());
events = ""; reset();
try { defaults(argument("1", undefined), abrupt(), argument("3", undefined)); } catch (error) { console.log("abrupt", error instanceof Error); }
console.log("order", events, trace());
events = "";
try { slots(argument("1", 1), argument("2", 2), argument("3", 3), abrupt()); } catch (error) { console.log("extra-abrupt", error instanceof Error); }
console.log("order", events);
events = ""; reset();
try { throwsDefault(argument("1", undefined), argument("2", undefined), argument("3", undefined)); } catch (error) { console.log("default-abrupt", error instanceof Error); }
console.log("default-order", events, trace());
