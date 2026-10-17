let sink: ((s: string) => void) | null = null;
let buffer: string[] | null = null;
function use(line: string): void {
  if (sink) sink(line);
  else console.log("absent", line);
  if (buffer) buffer.push(line);
}
use("first");
function install(callback: (s: string) => void): () => void {
  const previous = sink;
  sink = callback;
  return () => { sink = previous; };
}
const stop = install((s: string): void => { console.log("seen", s); });
const alias = stop;
buffer = [];
use("second");
alias();
use("third");
console.log(buffer.length);
let checks = 0;
function next(): ((s: string) => void) | null { checks = checks + 1; return sink; }
if (next()) console.log("present"); else console.log("checked", checks);
function optional(callback?: (s: string) => void): void { if (callback) callback("optional"); }
optional(); optional((s: string): void => { console.log(s); });
function result(callback: (() => number) | null): number { if (callback) return callback(); return 0; }
console.log(result(null), result((): number => 12));
