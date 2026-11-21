async function main(): Promise<void> {
  const seen: string[] = [];
  const value = await new Promise<number>(async (resolve, reject) => {
    await Promise.resolve();
    seen.push('after-await');
    resolve(7);
    void reject;
  });
  console.log(value, seen.join(','));
}

void main();
