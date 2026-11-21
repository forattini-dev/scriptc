async function left(): Promise<string> {
  const read = (await import("./dynamic-dependency-fail-left.ts")).read;
  return read();
}
async function right(): Promise<string> {
  const read = (await import("./dynamic-dependency-fail-right.ts")).read;
  return read();
}
void left().then((value) => console.log(value), (reason) => console.log(reason === "dependency failed"));
void right().then((value) => console.log(value), (reason) => console.log(reason === "dependency failed"));
console.log("entry");
