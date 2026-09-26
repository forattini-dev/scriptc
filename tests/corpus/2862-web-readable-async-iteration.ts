async function directBreak(): Promise<void> {
  const events: string[] = [];
  const stream = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
      controller.enqueue(2);
      controller.close();
    },
    cancel(reason) {
      events.push(String(reason));
    },
  });
  for await (const chunk of stream) {
    console.log("direct", chunk, typeof chunk);
    break;
  }
  console.log("direct state", stream.locked, JSON.stringify(events));
}

async function preserveBreak(): Promise<void> {
  const events: string[] = [];
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
    cancel(reason) {
      events.push(String(reason));
    },
  });
  for await (const chunk of stream.values({ preventCancel: true })) {
    console.log("preserve", chunk.toUpperCase());
    break;
  }
  console.log("preserve state", stream.locked, JSON.stringify(events));
  for await (const chunk of stream) {
    console.log("preserve rest", chunk);
  }
  console.log("preserve end", stream.locked, JSON.stringify(events));
}

async function returnFromLoop(stream: ReadableStream<number>): Promise<void> {
  for await (const chunk of stream) {
    console.log("return", chunk);
    return;
  }
}

async function returnCancels(): Promise<void> {
  const events: string[] = [];
  const stream = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(7);
      controller.enqueue(8);
    },
    cancel(reason) {
      events.push(String(reason));
    },
  });
  await returnFromLoop(stream);
  console.log("return state", stream.locked, JSON.stringify(events));
}

async function explicitIteratorMethod(): Promise<void> {
  const stream = ReadableStream.from(["symbol", "rest"]);
  for await (
    const chunk of stream[Symbol.asyncIterator]({ preventCancel: true })
  ) {
    console.log("symbol", chunk);
    break;
  }
  console.log("symbol state", stream.locked);
  for await (const chunk of stream) console.log("symbol rest", chunk);
}

async function main(): Promise<void> {
  await directBreak();
  await preserveBreak();
  await returnCancels();
  await explicitIteratorMethod();
}

void main();
