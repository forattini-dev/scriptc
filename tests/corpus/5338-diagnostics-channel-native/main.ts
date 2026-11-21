// @rust-only
// @no-engine
import { channel } from "node:diagnostics_channel";

const events = channel("scriptc:native");
const seen: string[] = [];
const listener = (message: unknown, name: string | symbol): void => {
  seen.push(`${String(name)}=${String(message)}`);
};

console.log(events.name, events.hasSubscribers);
events.subscribe(listener);
console.log(events.hasSubscribers);
events.publish("hello");
console.log(seen.join(","));
console.log(events.unsubscribe(listener), events.hasSubscribers);
