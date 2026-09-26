let trace = "";
function receiver() { trace += "r"; return "abcde"; }
function needle() { trace += "n"; return "bc"; }
function position() { trace += "p"; return "1.9"; }
console.log(receiver().indexOf(needle(), position()), trace);
trace = "";
console.log(receiver().includes(needle(), position()), trace);
trace = "";
console.log(receiver().indexOf(needle(), void position()), trace);
trace = "";
console.log(receiver().includes(needle(), void position()), trace);

/** @type {(number | string | boolean | null | undefined)[]} */
const positions = [undefined, null, false, true, "", "2.9", "bad", NaN, -Infinity, -3, 0, 1, 3, Infinity, 99];
for (const value of positions) {
  const text = "a😀bc😀d";
  console.log(text.indexOf("😀", value), text.indexOf("", value));
  console.log(text.includes("bc", value), text.includes("", value));
}
