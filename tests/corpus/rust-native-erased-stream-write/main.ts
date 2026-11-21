type Listener = (...args: any[]) => void;

class Client {
  private listeners: Listener[] = [];
  on(event: string, listener: Listener): this {
    if (event === "data") this.listeners.push(listener);
    return this;
  }
  feed(chunk: unknown): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

const client = new Client();
client.on("data", (d) => process.stdout.write(d));
client.on("data", (d) => process.stderr.write(typeof d === "string" ? `[${d.length}]\n` : "[bytes]\n"));
client.on("data", (d) => console.log("chunk", typeof d, d.length));
client.feed("login: ");
client.feed(Buffer.from("guest\n"));
client.feed("ready\n");
