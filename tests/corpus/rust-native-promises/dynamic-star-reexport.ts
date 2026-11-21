console.log("entry:start");

async function run(): Promise<void> {
  const { value, plusOne } = await import("./dynamic-star-barrel.ts");
  console.log("result", plusOne(value));
}

void run();
console.log("entry:end");
