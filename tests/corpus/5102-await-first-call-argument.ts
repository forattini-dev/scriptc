function double(value: number): number { return value * 2; }

async function calculate(flag: boolean): Promise<number> {
  const result = double(await Promise.resolve(4));
  if (flag) await Promise.resolve(undefined);
  return result;
}

async function main(): Promise<void> {
  const values = await Promise.all([calculate(true), calculate(false)]);
  console.log(values.join(","));
}
void main();
