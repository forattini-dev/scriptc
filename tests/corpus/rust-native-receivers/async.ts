// @rust-only
// @no-engine
export {};

const api = {
  value: "ready",
  read(): string { return this.value; },
  async run(log: string[]): Promise<void> {
    log.push(this.read());
    await Promise.resolve("tick");
    log.push(this.value);
  },
};

async function main(): Promise<void> {
  const log: string[] = [];
  await api.run(log);
  console.log("async-this", log.join(","));
}

void main();
