export {};

async function values(): Promise<void> {
  const [text, count] = await Promise.all([
    Promise.resolve("native"),
    Promise.resolve(7),
  ]);
  console.log(text);
  console.log(count);
}

void values();
