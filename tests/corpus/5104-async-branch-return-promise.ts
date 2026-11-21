async function choose(which: number): Promise<number> {
  if (which === 0) return Promise.resolve(2);
  if (which === 1) return Promise.reject(new Error("failed"));
  const result = await Promise.resolve(4);
  return result;
}

async function main(): Promise<void> {
  const values = await Promise.all([choose(0), choose(1).catch(() => 3), choose(2)]);
  console.log(values.join(","));
}
void main();
