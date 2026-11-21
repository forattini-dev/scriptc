async function main(): Promise<void> {
  const { TABLE } = await import("./module.ts");
  console.log(TABLE.native.family);
}

void main();
