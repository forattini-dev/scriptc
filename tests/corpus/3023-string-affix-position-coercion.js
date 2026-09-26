let trace = "";
function receiver() { trace += "r"; return "abcde"; }
function needle() { trace += "n"; return "bc"; }
function position() { trace += "p"; return "1.9"; }
console.log(receiver().startsWith(needle(), position()), trace);
trace = "";
console.log(receiver().endsWith(needle(), position()), trace);
trace = "";
console.log(receiver().endsWith(needle(), void position()), trace);

/** @type {(number | string | boolean | null | undefined)[]} */
const positions = [0, "1.9", true, false, null, undefined, NaN, Infinity];
for (const value of positions) {
  const text = "a😀bc";
  console.log(text.startsWith("😀", value), text.startsWith("bc", value));
  console.log(text.endsWith("😀", value), text.endsWith("bc", value));
  console.log(text.startsWith("", value), text.endsWith("", value));
}
