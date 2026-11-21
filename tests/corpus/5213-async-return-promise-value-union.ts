async function choose(flag: boolean): Promise<number> {
  return flag ? Promise.resolve(7) : 0;
}

async function main(): Promise<void> {
  const values = await Promise.all([choose(true), choose(false)]);
  console.log(values.join(","));
}

void main();
