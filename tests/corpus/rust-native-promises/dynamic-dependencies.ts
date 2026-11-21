async function left(): Promise<void> {
  const read = (await import("./dynamic-dependency-left.ts")).read;
  console.log(read());
}
async function right(): Promise<void> {
  const read = (await import("./dynamic-dependency-right.ts")).read;
  console.log(read());
}
void left();
void right();
console.log("entry");
