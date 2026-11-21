async function branch(first: boolean, second: boolean): Promise<boolean> {
  let deleted = 0;
  if (first) {
    deleted = await Promise.resolve(2);
  }
  if (second) {
    await Promise.resolve(undefined);
  }
  return second || deleted > 0;
}

async function main(): Promise<void> {
  const values = await Promise.all([
    branch(true, false),
    branch(false, false),
    branch(false, true),
    branch(true, true),
  ]);
  console.log(values.join(","));
}

void main();
