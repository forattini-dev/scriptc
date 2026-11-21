import { generate } from './generator.mjs';
async function main() {
  const box: { stdout: AsyncGenerator<any, void, unknown> } = { stdout: generate() };
  const first = await box.stdout.next();
  const second = await box.stdout.next();
  console.log(first.value);
  console.log(first.done);
  console.log(second.value);
  console.log(second.done);
  const optional: { stdout?: AsyncGenerator<any, void, unknown> } = { stdout: generate() };
  const generator = optional.stdout!;
  const again = await generator.next();
  console.log(again.value);
  console.log(again.done);
  const items: AsyncGenerator<any, void, unknown>[] = [generate()];
  const stored = items[0];
  const fromArray = await stored.next();
  console.log(fromArray.value);
  console.log(fromArray.done);
}
main();

