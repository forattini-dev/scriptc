console.log("abc".charAt(), "abc".charCodeAt(), "abc".substring(), "abc".slice());
console.log("abc".charAt(undefined), "abc".charCodeAt(undefined));
console.log("abc".slice(undefined, undefined), "abc".substring(undefined, undefined));
console.log("abc".charAt(null), "abc".charCodeAt(null));
console.log("abc".charAt(true), "abc".charCodeAt(false));
console.log("abc".slice(false, true), "abc".substring(true, false));
console.log("abcd".charAt("   +00200.0000E-0002   "), "abcd".charCodeAt("2.9"));
console.log("abc".charAt("x"), "abc".charCodeAt(""));
console.log("abcd".slice("-2.9", "Infinity"), "abcd".substring("2.9", "x"));
console.log("abc".slice(1, undefined), "abc".substring(1, undefined));
console.log("abc".slice(1, null), "abc".substring(1, null));
console.log("".charAt(), "".charCodeAt(), "".slice(), "".substring());

let trace = "";
function receiver() { trace += "r"; return "abcd"; }
function start() { trace += "s"; return "1.9"; }
function end() { trace += "e"; return "3.9"; }
console.log(receiver().slice(start(), end()), trace);
trace = "";
console.log(receiver().substring(start(), void end()), trace);
trace = "";
console.log(receiver().charAt(void start()), trace);
trace = "";
console.log(receiver().charCodeAt(void start()), trace);

function optionalEnd(end) { return "abcd".slice(1, end); }
console.log(optionalEnd(undefined), optionalEnd(3));
