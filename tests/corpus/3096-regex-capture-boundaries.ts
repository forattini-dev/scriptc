let evaluations = 0;
function getMatch(): RegExpExecArray {
  evaluations += 1;
  return /a(b)?/.exec("a")!;
}
try { console.log(getMatch()[1].length); }
catch (error) { console.log(String(error), evaluations); }
try { console.log(getMatch()[1].toUpperCase()); }
catch (error) { console.log(String(error), evaluations); }
const captures = [..."a ab".matchAll(/a(b)?/g)].map(match => match[1]);
console.log(JSON.stringify(captures));
function readCapture(match: RegExpExecArray) { return match[1]; }
console.log(readCapture(/a(b)?/.exec("a")!), readCapture(/a(b)?/.exec("ab")!));

const globalCapture = /a(b)?/.exec("a")![1];
const captureAlias = globalCapture;
console.log(globalCapture, captureAlias, captureAlias === undefined);
