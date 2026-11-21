import { make } from 'async-iterable-view';

async function main(): Promise<void> {
  const values: number[] = [];
  for await (const value of make().watch()) values.push(value);
  console.log(values.join(','));
}

main();
