// @rust-only
// @no-engine
async function parsed(): Promise<number> {
  const value = await Promise.resolve("4.5");
  return parseFloat(value);
}

void parsed().then((value) => console.log(value));
