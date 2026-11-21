import { EventEmitter } from "node:events";

interface Worker extends EventEmitter {
  start(): Promise<void>;
}

class LiveWorker extends EventEmitter implements Worker {
  async start(): Promise<void> {
    this.emit("ready");
  }
}

function create(): Worker {
  return new LiveWorker();
}

async function main(): Promise<void> {
  const worker = create();
  worker.once("ready", () => console.log("ready"));
  await worker.start();
  console.log("done");
}

void main();
