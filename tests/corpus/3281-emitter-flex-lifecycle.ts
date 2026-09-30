// @rust-only
// The checked-dynamic ("flex") EventEmitter path — reached whenever any site
// names an event with a computed string — must keep the SAME lifecycle as the
// typed path: registration order, once, prepend, function identity (the same
// reference registered twice fires twice and is removed one at a time),
// listener bookkeeping, the snapshot semantics of a removal performed DURING
// an emit, and the reserved `error` event staying on its own typed bucket
// rather than being swallowed by a computed pattern.
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
// A runtime-valued suffix behind a constant prefix: this is what switches
// the whole `topic:` family onto the flex representation.
const key = process.argv[2] ?? "alpha";
const topic = `topic:${key}`;

const log: string[] = [];

// --- registration order -----------------------------------------------
const first = (value: string): void => {
  log.push(`first:${value}`);
};
const second = (value: string): void => {
  log.push(`second:${value}`);
};
emitter.on(topic, first);
emitter.on(topic, second);
console.log("had-listeners", emitter.emit(topic, "a"));
console.log("order", log.join(","));

// --- prepend puts a listener in FRONT of the existing ones -------------
log.length = 0;
emitter.prependListener(topic, (value: string): void => {
  log.push(`pre:${value}`);
});
emitter.emit(topic, "b");
console.log("prepend", log.join(","));

// --- function identity: the same reference twice is two listeners ------
log.length = 0;
emitter.removeAllListeners(topic);
emitter.on(topic, first);
emitter.on(topic, first);
console.log("identity-count", emitter.listenerCount(topic), emitter.listenerCount(topic, first));
emitter.emit(topic, "c");
console.log("identity-fires", log.join(","));
// off removes ONE registration, not both.
emitter.off(topic, first);
log.length = 0;
emitter.emit(topic, "d");
console.log("identity-after-off", emitter.listenerCount(topic), log.join(","));

// --- once fires exactly once and then unregisters ----------------------
log.length = 0;
emitter.removeAllListeners(topic);
let onceCalls = 0;
emitter.once(topic, (value: string): void => {
  onceCalls += 1;
  log.push(`once:${value}`);
});
emitter.on(topic, second);
console.log("once-first", emitter.emit(topic, "e"), emitter.listenerCount(topic));
console.log("once-second", emitter.emit(topic, "f"), emitter.listenerCount(topic));
console.log("once-calls", onceCalls, log.join(","));

// --- removal DURING an emit: Node emits over a snapshot ---------------
// The first listener removes the third while the emit is in flight. Node
// copies the handler list before dispatching, so the third STILL runs for
// this emit and is gone for the next one.
log.length = 0;
emitter.removeAllListeners(topic);
const third = (value: string): void => {
  log.push(`third:${value}`);
};
emitter.on(topic, (value: string): void => {
  log.push(`remover:${value}`);
  emitter.off(topic, third);
});
emitter.on(topic, second);
emitter.on(topic, third);
emitter.emit(topic, "g");
console.log("remove-during", log.join(","), emitter.listenerCount(topic));
log.length = 0;
emitter.emit(topic, "h");
console.log("remove-after", log.join(","));

// --- a listener that removes ITSELF during its own emit ---------------
log.length = 0;
emitter.removeAllListeners(topic);
const selfRemoving = (value: string): void => {
  log.push(`self:${value}`);
  emitter.off(topic, selfRemoving);
};
emitter.on(topic, selfRemoving);
emitter.emit(topic, "i");
emitter.emit(topic, "j");
console.log("self-remove", log.join(","), emitter.listenerCount(topic));

// --- removeAllListeners during an emit --------------------------------
log.length = 0;
emitter.removeAllListeners(topic);
emitter.on(topic, (value: string): void => {
  log.push(`clearer:${value}`);
  emitter.removeAllListeners(topic);
});
emitter.on(topic, second);
emitter.emit(topic, "k");
console.log("clear-during", log.join(","), emitter.listenerCount(topic));

// --- payload arity crosses the dyn boundary ---------------------------
// A rest parameter cannot cross the checked-dynamic boundary, so arity is
// covered by fixed-arity listeners: a zero-parameter listener still runs
// for an emit that carries payloads, and a multi-parameter listener
// receives each one positionally.
const zeroArg = new EventEmitter();
const zeroTopic = `zero:${key}`;
zeroArg.on(zeroTopic, (): void => {
  console.log("zero-arg-ran");
});
console.log("zero-arg", zeroArg.emit(zeroTopic), zeroArg.emit(zeroTopic, "ignored", "also"));

const multiArg = new EventEmitter();
const multiTopic = `multi:${key}`;
multiArg.on(multiTopic, (a: string, b: string, c: string): void => {
  console.log("multi-arg", a, b, c);
});
multiArg.emit(multiTopic, "one", "two", "three");

const shaped = new EventEmitter();
const shapedTopic = `shape:${key}`;
shaped.on(shapedTopic, (value: number): void => {
  console.log("number-payload", value, value + 1);
});
shaped.emit(shapedTopic, 41);
const stringy = new EventEmitter();
const stringyTopic = `text:${key}`;
stringy.on(stringyTopic, (value: string): void => {
  console.log("string-payload", value, value.length);
});
stringy.emit(stringyTopic, "héllo ☃");

// --- emit with no listener answers false and calls nothing ------------
const empty = new EventEmitter();
console.log("no-listener", empty.emit(`gone:${key}`, "x"));

// --- a LITERAL name matched by the computed pattern joins the same
// bucket, so both spellings must reach the same listeners --------------
const shared = new EventEmitter();
let sharedCalls = 0;
shared.on(`topic:${key}`, (): void => {
  sharedCalls += 1;
});
shared.emit("topic:alpha", "literal");
shared.emit(`topic:${key}`, "computed");
console.log("literal-and-computed", sharedCalls);

// --- the reserved `error` event keeps its own typed behaviour ---------
// The computed pattern above may not overlap `error`, so an error listener
// on the same emitter stays on the typed path and still receives the
// Error object.
const failing = new EventEmitter();
failing.on(`topic:${key}`, (): void => {
  log.push("unused");
});
failing.on("error", (err: Error): void => {
  console.log("error-listener", err.message);
});
console.log("error-emit", failing.emit("error", new Error("boom")));
// listener bookkeeping sees both buckets.
console.log("names", failing.eventNames().join(","));

console.log("done");
