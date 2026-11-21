async function left(): Promise<void> {
  const value = (await import("./dynamic-jobs-left.ts")).value;
  console.log(value());
}
async function right(): Promise<void> {
  const value = (await import("./dynamic-jobs-right.ts")).value;
  console.log(value());
}
void left();
void right();
console.log("entry");
