console.log("entry:start");

async function run(): Promise<void> {
  const { value, format } = await import("./dynamic-exported-destructure-module.ts");
  console.log("result", value, format(7));
}

void run();
console.log("entry:end");
