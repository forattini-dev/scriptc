async function run(): Promise<void> {
  const { CustomError } = await import("./dynamic-class-lib.ts");
  const error = new CustomError();
  console.log(error.message);
  console.log(error.name);
}
void run();
console.log("entry");
