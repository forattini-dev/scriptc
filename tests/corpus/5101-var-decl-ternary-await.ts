async function choose(first: boolean): Promise<string> {
  const value = first
    ? await Promise.resolve("a")
    : await Promise.resolve("b");
  return value;
}

async function main(): Promise<void> {
  const values = await Promise.all([choose(true), choose(false)]);
  console.log(values.join(","));
}

void main();
