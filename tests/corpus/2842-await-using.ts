const events: string[] = [];

class AsyncResource {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    events.push("open " + name);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    events.push("close start " + this.name);
    await Promise.resolve();
    events.push("close end " + this.name);
  }
}

class SyncResource {
  [Symbol.dispose](): void {
    events.push("close sync");
  }
}

async function work(): Promise<string> {
  await using first = new AsyncResource("first");
  await using second = new AsyncResource("second");
  await using sync = new SyncResource();
  events.push("body");
  return "done";
}

async function main(): Promise<void> {
  console.log(await work());
  console.log(events.join(" | "));
}

main();
