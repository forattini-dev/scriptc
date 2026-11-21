async function total(): Promise<number> {
  let value = 0;
  let index = 0;
  while (index < 3) {
    value += index;
    index += 1;
  }
  if (value === 3) {
    await Promise.resolve(undefined);
  }
  return value;
}

async function main(): Promise<void> {
  const result = await total();
  console.log(result);
}

void main();
