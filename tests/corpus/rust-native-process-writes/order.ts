// @rust-only
// @no-engine
let count = 0;
function text(): string { count = count + 1; process.stdout.write("before:"); return `value${count}\n`; }
(process.stdout.write(text()));
console.log("once", count);
try { process.stdout.write(fail()); } catch { console.log("caught"); }
function fail(): string { process.stderr.write("throwing\n"); throw new Error("stop"); }
function shadow(process: { stderr: { write: (text: string) => boolean } }): void {
  console.log("shadow return", process.stderr.write("custom"));
}
shadow({ stderr: { write: (text: string): boolean => { console.log(text); return false; } } });
