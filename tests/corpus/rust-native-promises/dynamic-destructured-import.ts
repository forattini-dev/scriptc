console.log("entry:start");

async function run(): Promise<void> {
  const { read } = await import("./dynamic-destructured-module.ts");
  console.log("result", read());
}

void run();
console.log("entry:end");
