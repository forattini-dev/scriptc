// Typed async generators: lazy creation, synchronous request start,
// asynchronous successful settlement, queued next/return requests, await
// and promised yields, throw injection, and finally-yield return behavior.
const ordering: string[] = [];

async function* ordered(): AsyncGenerator<number, void, undefined> {
  ordering.push("body");
  yield 1;
}

async function showOrdering(): Promise<void> {
  ordering.push("before");
  const first = ordered().next();
  ordering.push("after");
  void first.then(() => ordering.push("settled"));
  queueMicrotask(() => ordering.push("micro"));
  await first;
  await Promise.resolve();
  console.log(ordering.join(","));
}

async function* promisedYield(events: string[]): AsyncGenerator<number, void, undefined> {
  events.push("body1");
  yield Promise.resolve(1);
  events.push("body2");
  yield 2;
}

async function showPromisedYieldOrdering(): Promise<void> {
  const events: string[] = [];
  const iterator = promisedYield(events);
  const first = iterator.next();
  const second = iterator.next();
  void first.then(() => events.push("first"));
  void second.then(() => events.push("second"));
  queueMicrotask(() => events.push("micro"));
  events.push("end");
  await first;
  await second;
  await Promise.resolve();
  console.log(events.join(","));
}

async function* values(): AsyncGenerator<number, number, undefined> {
  console.log("values body");
  yield 1;
  await Promise.resolve();
  yield Promise.resolve(2);
  return 3;
}

async function showQueue(): Promise<void> {
  const iterator = values();
  console.log("made");
  const first = iterator.next();
  const second = iterator.next();
  const returned = iterator.return(9);
  console.log("queued");
  console.log(JSON.stringify(await first));
  console.log(JSON.stringify(await second));
  console.log(JSON.stringify(await returned));
}

async function* sentValues(): AsyncGenerator<number, string, string> {
  const message = yield 5;
  return message;
}

async function showSentValues(): Promise<void> {
  const iterator = sentValues();
  const first = iterator.next("discarded");
  const second = iterator.next("accepted");
  console.log(JSON.stringify(await first));
  console.log(JSON.stringify(await second));
  const forced = sentValues();
  console.log(JSON.stringify(await forced.return("forced")));
}

async function* catches(): AsyncGenerator<string, void, undefined> {
  try {
    yield "ready";
    yield "miss";
  } catch (error) {
    if (error instanceof Error) console.log("caught", error.message);
    yield "after";
  } finally {
    console.log("caught finally");
  }
}

async function showThrow(): Promise<void> {
  const iterator = catches();
  console.log(JSON.stringify(await iterator.next()));
  console.log(JSON.stringify(await iterator.throw(new Error("boom"))));
  console.log(JSON.stringify(await iterator.next()));
}

async function* closing(): AsyncGenerator<number, number, undefined> {
  try {
    yield 1;
  } finally {
    console.log("closing finally");
    yield 4;
    console.log("closing finally 2");
  }
  return 0;
}

async function showReturn(): Promise<void> {
  const iterator = closing();
  console.log(JSON.stringify(await iterator.next()));
  console.log(JSON.stringify(await iterator.return(8)));
  console.log(JSON.stringify(await iterator.next()));
  console.log(JSON.stringify(await iterator.next()));
}

async function* fails(): AsyncGenerator<number, void, undefined> {
  throw new Error("body failure");
}

async function showFailure(): Promise<void> {
  try {
    await fails().next();
  } catch (error) {
    if (error instanceof Error) console.log(error.message);
  }
  const iterator = values();
  try {
    await iterator.throw(new Error("early"));
  } catch (error) {
    if (error instanceof Error) console.log(error.message);
  }
  console.log(JSON.stringify(await iterator.next()));
}

async function main(): Promise<void> {
  await showOrdering();
  await showPromisedYieldOrdering();
  await showQueue();
  await showSentValues();
  await showThrow();
  await showReturn();
  await showFailure();
}

void main();
