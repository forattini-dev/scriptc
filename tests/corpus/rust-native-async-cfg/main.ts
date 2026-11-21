// @rust-only
// @no-engine
export {};
async function value(input: number): Promise<number> {
  if (input > 0 && (await Promise.resolve(input)) > 1) {
    try {
      if ((await Promise.resolve(input + 1)) > 3) return 7;
      await Promise.resolve(undefined);
    } catch {
      return 8;
    }
  }
  return 9;
}

void value(3).then((result) => console.log(result));
