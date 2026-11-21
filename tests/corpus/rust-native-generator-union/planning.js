import { events } from "./events.ts";

// @ts-ignore The exported erased ABI performs runtime iterator checks.
export function consume(values) {
  for (const event of values) {
    console.log(`${event.type}:${event.value}`);
  }
}

consume(events(false));
