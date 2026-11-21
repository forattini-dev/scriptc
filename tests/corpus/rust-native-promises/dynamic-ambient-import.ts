console.log("entry:start");

async function run(): Promise<void> {
  const { value } = await import("./dynamic-ambient-module.ts");
  console.log("result", value);
}

void run();
console.log("entry:end");
