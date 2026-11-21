async function getValue(): Promise<string> {
  return "record";
}

function encodeRecord(value: string): string {
  return value.toUpperCase();
}

async function handle(found: boolean): Promise<string> {
  if (found) return encodeRecord(await getValue());
  return "missing";
}

async function main(): Promise<void> {
  console.log(await handle(true));
  console.log(await handle(false));
}

main();
