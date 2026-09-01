export async function main(argv) {
  await Promise.resolve();
  return this.main === main ? argv.length + 10 : -1;
}

export async function renderAutomaticCommandOutput(stdout, command, level) {
  await Promise.resolve();
  return Buffer.concat([stdout, Buffer.from(`:${command}:${level ?? "auto"}`)]);
}

export function renderCliFailure(error) {
  return { output: Buffer.from(String(error)), status: 17 };
}
