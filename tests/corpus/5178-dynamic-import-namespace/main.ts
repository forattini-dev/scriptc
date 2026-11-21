async function main(): Promise<void> {
  const mod = await import("./module.ts");
  console.log(mod.second(mod.first()));
}

void main();
