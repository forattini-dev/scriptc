async function main(): Promise<void> {
  console.log("before");
  const first = await import("./a.ts");
  console.log(first.value());
  const second = await import("./a.ts");
  console.log(first === second);
}

void main();
