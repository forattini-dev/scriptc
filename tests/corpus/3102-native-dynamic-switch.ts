// @no-engine
let trace = "";
function read(value: unknown): unknown { trace += "disc;"; return value; }
function candidate(name: string, value: unknown): unknown { trace += name + ";"; return value; }
function run(value: unknown): void {
  trace = "";
  let result = "";
  choice: switch (read(value)) {
    case candidate("one", 1): result += "number;";
    default: result += "default;";
    case candidate("text", "1"): result += "text;"; break choice;
    case candidate("null", null): result += "null;";
  }
  console.log(result, trace);
}
run(1); run("1"); run(null); run(false);
function classify(value: unknown): string {
  switch (value) {
    case undefined: return "undefined";
    case null: return "null";
    case true: return "true";
    case 0: return "zero";
    case NaN: return "nan-matched";
    default: return "other";
  }
}
console.log(classify(undefined), classify(null), classify(true), classify(-0), classify(NaN), classify("0"));
trace = "";
switch (read(1)) {}
console.log("empty", trace);

let changing: unknown = "original";
function change(): unknown { changing = "later"; return "miss"; }
switch (changing) {
  case change(): console.log("wrong first"); break;
  case "later": console.log("wrong reread"); break;
  case "original": console.log("saved discriminant", changing); break;
}
console.log(changing);

const indexed: string[] = ["present"];
function indexedCase(value: unknown): void {
  switch (value) {
    case indexed[1]: console.log("missing index"); break;
    case indexed[0]: console.log("present index"); break;
    default: console.log("neither index");
  }
}
indexedCase(undefined); indexedCase("present"); indexedCase(null);
