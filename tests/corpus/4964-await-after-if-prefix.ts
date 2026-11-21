export {};

async function parsed(flag: boolean): Promise<number> {
  let prefix = "3";
  if (flag) {
    prefix = "4";
  }
  const value = await Promise.resolve(prefix + ".5");
  return parseFloat(value);
}

void parsed(true).then((value) => console.log(value));
