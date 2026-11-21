export {};

async function readName(): Promise<string> {
  return "scriptc";
}

async function main(): Promise<void> {
  let name: string | undefined;
  name = await readName();
  console.log(name);
}

void main();
