async function upload(): Promise<string> {
  let index = 0;
  const done: string[] = [];
  while (index < 5) {
    const item = index;
    index += 1;
    if (item === 1) continue;
    if (item === 4) break;
    try {
      await (item === 2 ? Promise.reject(new Error("lost")) : Promise.resolve(undefined));
      done.push(`ok:${item}`);
    } catch (error) {
      const recovered = await Promise.resolve(error instanceof Error);
      if (!recovered) throw error;
      done.push(`recovered:${item}`);
    }
  }
  return done.join(",");
}
async function main(): Promise<void> {
  const result = await upload();
  console.log(result);
}
void main();
