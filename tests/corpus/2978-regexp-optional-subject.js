console.log(/^undefined$/.test(), /^undefined$/.test(undefined));
console.log(/^null$/.test(null), /^123$/.test(123), /^true$/.test(true));
console.log(JSON.stringify(/^(undefined)$/.exec()));
console.log(JSON.stringify(/^(undefined)$/.exec(undefined)));
console.log(JSON.stringify(/^(null)$/.exec(null)));
console.log(JSON.stringify(/^(123)$/.exec(123)));
let effects = 0;
console.log(/^undefined$/.test(void effects++), effects);
let trace = "";
function receiver() { trace += "r"; return /^x$/; }
function subject() { trace += "s"; return "x"; }
console.log(JSON.stringify(receiver().exec(subject())), trace);
let current = /^x$/;
function changeReceiver() { current = /^y$/; return "x"; }
console.log(JSON.stringify(current.exec(changeReceiver())));
