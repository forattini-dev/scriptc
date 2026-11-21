import type { Event } from "./paired-stream.js";

export declare function buildValueFromEvents(events: Iterable<Event>): number;
export declare function decodeFromLines(lines: Iterable<number>): number;
