// @rust-only
// @no-engine
// @ts-nocheck

function emit(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(text);
}

const first = process.stdout;
const second = process.stdout;
console.log(first === second);
console.log("isTTY" in first);
emit("stdout-value\n");
emit("stderr-value\n", process.stderr);
