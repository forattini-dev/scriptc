class Logger {
  private lines = 0;
  plain(message: string): void {
    this.lines += 1;
    console.log(`[${this.lines}] ${message}`);
  }
}
const log = new Logger();

async function share(tool: string | undefined): Promise<number> {
  const mod = await import("./shared.ts");
  if (!tool) {
    log.plain(`shareable: ${mod.adoptableTools().join(", ")}`);
    return 0;
  }
  return await mod.adoptConfig(tool);
}

async function main(): Promise<void> {
  console.log(await share(undefined));
  console.log(await share("git"));
  try {
    await share("fish");
  } catch (error) {
    log.plain((error as Error).message);
  }
}

main();
