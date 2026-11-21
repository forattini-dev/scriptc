async function main(): Promise<void> {
  console.log("before");
  const first = await import("./module.ts");
  console.log(first.value);
  const second = await import("./module.ts");
  console.log(second.value);
}

void main();
