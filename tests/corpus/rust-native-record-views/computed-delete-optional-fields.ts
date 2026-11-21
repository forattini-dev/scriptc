interface TelemetryEvent {
  collection: string;
  raw_text?: string;
  emitted_text?: string;
  [key: string]: unknown;
}

function compact(event: TelemetryEvent, field: "raw_text" | "emitted_text"): TelemetryEvent {
  const next = { ...event };
  delete next[field];
  return next;
}

console.log(JSON.stringify(compact({ collection: "events", raw_text: "raw", emitted_text: "out" }, "raw_text")));
