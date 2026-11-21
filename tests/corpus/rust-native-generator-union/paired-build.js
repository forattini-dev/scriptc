import { decodeFromLines as decodeEventsFromLines } from "./paired-stream.js";

export function buildValueFromEvents(events) {
  let total = 0;
  for (const event of events) {
    total += event.value;
  }
  return total;
}

export function decodeFromLines(lines) {
  return buildValueFromEvents(decodeEventsFromLines(lines));
}
