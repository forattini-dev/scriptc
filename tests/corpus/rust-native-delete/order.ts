// @rust-only
// @no-engine
export {};
let events = "";
const data: {value?: number} = {value: 3};
function receiver(): {value?: number} { events = events + "receiver;"; return data; }
function key(): "value" { events = events + "key;"; return "value"; }
console.log(delete receiver()[key()], events, Object.hasOwn(data, "value"));
function badKey(): "value" { events = events + "throw;"; throw new Error("key failed"); }
try { delete receiver()[badKey()]; } catch (error) { console.log((error as Error).message); }
console.log(events);
let pending = 0;
try {
  try { pending = 1; delete receiver()[badKey()]; }
  finally { console.log("finally", pending, events); }
} catch (error) { console.log("caught", (error as Error).message); }
