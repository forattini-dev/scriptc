/** @param {unknown} start @param {unknown} end */
function dynamicPosition(start, end) {
  console.log("abcd".charAt(start), "abcd".charCodeAt(start));
  console.log("abcd".slice(start, end), "abcd".substring(start, end));
}
dynamicPosition(undefined, undefined);
dynamicPosition(null, null);
dynamicPosition(true, "3.9");
dynamicPosition("2.9", false);

let trace = "";
function receiver() { trace += "r"; return "abcd"; }
function end() { trace += "e"; return 3; }
/** @param {unknown} start */
function slice(start) { return receiver().slice(start, end()); }
/** @param {unknown} start */
function substring(start) { return receiver().substring(start, void end()); }
const position = { valueOf() { trace += "v"; return "1.9"; } };
console.log(slice(position), trace);
trace = "";
console.log(substring(position), trace);

const throwing = { valueOf() { trace += "v"; throw new RangeError("position"); } };
trace = "";
try { slice(throwing); } catch (error) { console.log(error.name, error.message, trace); }

function endThrow() { trace += "e"; throw new RangeError("end expression"); }
/** @param {unknown} start */
function abruptEnd(start) { return receiver().slice(start, endThrow()); }
trace = "";
try { abruptEnd(position); } catch (error) { console.log(error.name, error.message, trace); }

/** @param {unknown} start @param {unknown} finish */
function both(start, finish) { return receiver().slice(start, finish); }
const finish = { valueOf() { trace += "f"; return 3; } };
trace = "";
console.log(both(position, finish), trace);

let cursor = ["a", "b", "c", "d"].join("");
let steps = 0;
while (cursor.charAt(JSON.parse("0")) !== "") {
  cursor = cursor.slice(JSON.parse("1"));
  steps++;
}
console.log("steps", steps, cursor);

/** @type {(number | string | boolean | null | undefined)[]} */
const positions = [0, "1.9", true, null, undefined];
for (const value of positions) {
  const text = ["a", "b", "c", "d"].join("");
  console.log(text.charAt(value), text.charCodeAt(value), text.slice(value), text.substring(1, value));
}
