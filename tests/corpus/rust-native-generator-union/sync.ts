type Event = { type: string; value: number };

function* syncEvents(): Generator<Event, void, unknown> {
  yield { type: "value", value: 4 };
}

async function* asyncEvents(): AsyncGenerator<Event, void, unknown> {
  yield { type: "value", value: 9 };
}

function events(useAsync: boolean): Generator<Event, void, unknown> | AsyncGenerator<Event, void, unknown> {
  return useAsync ? asyncEvents() : syncEvents();
}

function consume(values: Generator<Event, void, unknown> | AsyncGenerator<Event, void, unknown>): void {
  // @ts-expect-error This call path supplies the synchronous branch.
  for (const event of values) {
    console.log(`${event.type}:${event.value}`);
  }
}

consume(events(false));
