async function main(): Promise<void> {
  const [waits] = await Promise.all([
    import('./mod.ts').then((module) => module.listWaits(), () => [] as string[]),
  ]);
  console.log(waits.join(','));
}

void main();
