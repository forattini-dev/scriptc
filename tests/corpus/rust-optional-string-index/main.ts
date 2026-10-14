// @no-engine
const text = "a\u{1f680}z";
function observe(index: number): void {
  const char = text[index];
  console.log(index, typeof char, char ?? "missing");
  if (char !== undefined) console.log("unit", char.length, text.charCodeAt(index));
}
observe(0);
observe(-0);
observe(1);
observe(2);
observe(3);
observe(4);
observe(-1);
observe(0.5);
observe(NaN);
observe(Infinity);
observe(-Infinity);
observe(4294967295);
console.log("empty", ""[0] === undefined);

let source = "before";
function receiver(): string {
  console.log("receiver", source);
  return source;
}
function index(): number {
  console.log("index", source);
  source = "";
  return 0;
}
console.log("snapshot", receiver()[index()], source);
function forward(value: string | undefined): string | undefined { return value; }
console.log("forward", forward(text[100]) === undefined, forward(text[0]));
console.log("concat", "value=" + text[100]);
