interface Context {
  name: string;
}

let calls = 0;
async function contextFor(): Promise<Context> {
  calls++;
  return { name: "native" };
}

async function run(): Promise<void> {
  let context: Context | null = null;
  const first = (context ??= await contextFor());
  const second = (context ??= await contextFor());
  console.log(`${first.name}:${second.name}:${calls}`);
}

void run();
