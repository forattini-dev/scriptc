export type Event = { type: string; value: number };

function* syncEvents(): Generator<Event, void, unknown> {
  yield { type: "value", value: 4 };
}

async function* asyncEvents(): AsyncGenerator<Event, void, unknown> {
  yield { type: "value", value: 9 };
}

export function events(useAsync: boolean): Generator<Event, void, unknown> | AsyncGenerator<Event, void, unknown> {
  return useAsync ? asyncEvents() : syncEvents();
}
